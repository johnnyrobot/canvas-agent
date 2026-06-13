/**
 * Docling ingestion sidecar facade: ties the `docling-serve` lifecycle to the
 * convert client and exposes a small read-only conversion API (PRD §16).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ConvertOptions, ConvertedDocument, FileSource, IngestConfig } from './types.js';
import { loadIngestConfig, type Env } from './config.js';
import { DoclingClient } from './client.js';
import { DoclingProcess, type IngestProcessLogger } from './process.js';

/** The convert surface the sidecar facade needs (real `DoclingClient` satisfies it). */
type ConvertClient = Pick<DoclingClient, 'convertFile' | 'convertUrl'>;
/** The lifecycle surface the facade needs (real `DoclingProcess` satisfies it). */
type SidecarProcess = Pick<DoclingProcess, 'ensureRunning' | 'stop' | 'isHealthy'>;

export interface CreateIngestOptions {
  env?: Env;
  logger?: IngestProcessLogger;
  /** Test seam: inject a fake convert client (defaults to the real `DoclingClient`). */
  client?: ConvertClient;
  /** Test seam: inject a fake process lifecycle (defaults to the real `DoclingProcess`). */
  process?: SidecarProcess;
}

export class DoclingSidecar {
  readonly config: IngestConfig;
  private readonly client: ConvertClient;
  private readonly process: SidecarProcess;

  constructor(options: CreateIngestOptions = {}) {
    this.config = loadIngestConfig(options.env);
    this.client = options.client ?? new DoclingClient(this.config);
    this.process = options.process ?? new DoclingProcess(this.config, options.logger);
  }

  /** Memoized in-flight start so concurrent/repeat conversions spawn the daemon once. */
  private starting: Promise<void> | undefined;

  /**
   * Ensure the daemon is up before any conversion (attach-if-running /
   * spawn-if-not). Memoized on success; cleared on failure so a later call can
   * retry. Without this, `convert*` hit a dead endpoint because nothing ever
   * starts the sidecar (the lifecycle was never wired into the runtime).
   */
  private ensureStarted(): Promise<void> {
    if (!this.starting) {
      this.starting = this.process.ensureRunning().catch((err: unknown) => {
        this.starting = undefined;
        throw err;
      });
    }
    return this.starting;
  }

  async start(): Promise<void> {
    await this.ensureStarted();
  }

  async stop(): Promise<void> {
    this.starting = undefined;
    await this.process.stop();
  }

  isHealthy(): Promise<boolean> {
    return this.process.isHealthy();
  }

  /** Convert a user-supplied file (base64 + filename). */
  async convert(file: FileSource, opts?: ConvertOptions): Promise<ConvertedDocument> {
    await this.ensureStarted();
    return this.client.convertFile(file, opts);
  }

  /** Convenience: read a local file from disk and convert it. */
  async convertPath(path: string, opts?: ConvertOptions): Promise<ConvertedDocument> {
    await this.ensureStarted();
    const base64 = (await readFile(path)).toString('base64');
    return this.client.convertFile({ base64, filename: basename(path) }, opts);
  }

  /** Convert a document by URL. */
  async convertUrl(url: string, opts?: ConvertOptions): Promise<ConvertedDocument> {
    await this.ensureStarted();
    return this.client.convertUrl(url, opts);
  }
}

export function createDoclingSidecar(options?: CreateIngestOptions): DoclingSidecar {
  return new DoclingSidecar(options);
}

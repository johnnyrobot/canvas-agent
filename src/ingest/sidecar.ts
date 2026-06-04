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

export interface CreateIngestOptions {
  env?: Env;
  logger?: IngestProcessLogger;
}

export class DoclingSidecar {
  readonly config: IngestConfig;
  private readonly client: DoclingClient;
  private readonly process: DoclingProcess;

  constructor(options: CreateIngestOptions = {}) {
    this.config = loadIngestConfig(options.env);
    this.client = new DoclingClient(this.config);
    this.process = new DoclingProcess(this.config, options.logger);
  }

  async start(): Promise<void> {
    await this.process.ensureRunning();
  }

  async stop(): Promise<void> {
    await this.process.stop();
  }

  isHealthy(): Promise<boolean> {
    return this.process.isHealthy();
  }

  /** Convert a user-supplied file (base64 + filename). */
  convert(file: FileSource, opts?: ConvertOptions): Promise<ConvertedDocument> {
    return this.client.convertFile(file, opts);
  }

  /** Convenience: read a local file from disk and convert it. */
  async convertPath(path: string, opts?: ConvertOptions): Promise<ConvertedDocument> {
    const base64 = (await readFile(path)).toString('base64');
    return this.client.convertFile({ base64, filename: basename(path) }, opts);
  }

  /** Convert a document by URL. */
  convertUrl(url: string, opts?: ConvertOptions): Promise<ConvertedDocument> {
    return this.client.convertUrl(url, opts);
  }
}

export function createDoclingSidecar(options?: CreateIngestOptions): DoclingSidecar {
  return new DoclingSidecar(options);
}

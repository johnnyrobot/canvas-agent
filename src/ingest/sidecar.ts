/**
 * Docling ingestion sidecar facade: ties the `docling-serve` lifecycle to the
 * convert client and exposes a small read-only conversion API (PRD §16).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  ConvertOptions,
  ConvertedDocument,
  FileSource,
  IngestConfig,
  IngestPullProgress,
} from './types.js';
import { loadIngestConfig, type Env } from './config.js';
import { DoclingClient } from './client.js';
import { DoclingProcess, type IngestProcessLogger } from './process.js';
import { downloadModels, type DownloadSpawnLike } from './model-download.js';

/** The convert surface the sidecar facade needs (real `DoclingClient` satisfies it). */
type ConvertClient = Pick<DoclingClient, 'convertFile' | 'convertUrl'>;
/** The lifecycle surface the facade needs (real `DoclingProcess` satisfies it). */
type SidecarProcess = Pick<DoclingProcess, 'ensureRunning' | 'stop' | 'isHealthy' | 'modelsPresent'>;

export interface CreateIngestOptions {
  env?: Env;
  logger?: IngestProcessLogger;
  /** Test seam: inject a fake convert client (defaults to the real `DoclingClient`). */
  client?: ConvertClient;
  /** Test seam: inject a fake process lifecycle (defaults to the real `DoclingProcess`). */
  process?: SidecarProcess;
  /** Test seam: inject a fake spawn for the model download (defaults to real). */
  downloadSpawn?: DownloadSpawnLike;
  /** Test seam: resolve the bundled launcher for the download tooling (defaults to real). */
  downloadResolveCommand?: (name: string) => string;
}

export class DoclingSidecar {
  readonly config: IngestConfig;
  private readonly client: ConvertClient;
  private readonly process: SidecarProcess;
  private readonly downloadSpawn: DownloadSpawnLike | undefined;
  private readonly downloadResolveCommand: ((name: string) => string) | undefined;

  constructor(options: CreateIngestOptions = {}) {
    this.config = loadIngestConfig(options.env);
    this.client = options.client ?? new DoclingClient(this.config);
    this.process = options.process ?? new DoclingProcess(this.config, options.logger);
    this.downloadSpawn = options.downloadSpawn;
    this.downloadResolveCommand = options.downloadResolveCommand;
  }

  /**
   * Whether the conversion models are present locally. Office/web/markdown files
   * convert without any models; PDFs and scanned images need them, so the app
   * uses this to offer a first-run download. Mirrors the LLM `modelStatus` shape.
   */
  async modelStatus(): Promise<{ available: boolean }> {
    return { available: this.process.modelsPresent() };
  }

  /**
   * First-run provisioning: download the Docling conversion models into the
   * per-user store, reporting progress. No-op (resolves immediately) when the
   * models are already present. Unlike the LLM pull this does NOT need the
   * daemon — it drives the bundled Python downloader directly, so it works
   * before docling-serve can even start. Rejects if run outside the packaged app
   * (no bundled Python) or on a download failure.
   */
  async pullModel(
    onProgress?: (p: IngestPullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.process.modelsPresent()) {
      onProgress?.({ status: 'success', percent: 100 });
      return;
    }
    if (!this.config.modelsDir) {
      throw new Error('In-app model download requires a configured model store (DOCLING_MODELS_DIR).');
    }
    const opts: Parameters<typeof downloadModels>[0] = { modelsDir: this.config.modelsDir };
    if (signal) opts.signal = signal;
    if (this.downloadSpawn) opts.spawnImpl = this.downloadSpawn;
    if (this.downloadResolveCommand) opts.resolveCommand = this.downloadResolveCommand;
    for await (const p of downloadModels(opts)) {
      onProgress?.(p);
    }
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

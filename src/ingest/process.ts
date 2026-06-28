/**
 * Lifecycle manager for the bundled `docling-serve` sidecar — same attach/spawn/
 * stop pattern as the Ollama process manager. docling-serve is Python; it ships
 * as a local subprocess (PRD §16.4).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import type { IngestConfig } from './types.js';
import { resolveSidecarCommand } from '../runtime/bundled-resources.js';

export interface IngestProcessLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: IngestProcessLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Injection seam for `child_process.spawn` so the lifecycle is unit-testable. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export class DoclingProcess {
  private child: ChildProcess | undefined;
  private owned = false;
  /** Set by the child's `error` event (e.g. ENOENT when the binary isn't on PATH). */
  private spawnError: Error | undefined;

  constructor(
    private readonly config: IngestConfig,
    private readonly log: IngestProcessLogger = noopLogger,
    private readonly spawnImpl: SpawnLike = spawn,
    /** Resolve the `docling-serve` command — bundled abs path when packaged, else PATH. */
    private readonly resolveCommand: (name: string) => string = resolveSidecarCommand,
  ) {}

  get isOwned(): boolean {
    return this.owned;
  }

  /**
   * Whether the downloaded conversion models are present on disk. Only meaningful
   * when `config.modelsDir` is set (the packaged app's per-user store); without
   * it we can't tell (the bundled launcher may have its own `models/`), so we
   * optimistically report `true` and let conversion surface any real gap.
   */
  modelsPresent(): boolean {
    const dir = this.config.modelsDir;
    if (!dir) return true;
    try {
      return existsSync(dir) && readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  }

  /**
   * docling-serve has no documented health endpoint, so we treat ANY HTTP
   * response (even 404) as "the server is listening". A connection error = down.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await fetch(this.config.baseUrl + this.config.healthPath, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) {
      this.log.info('docling-serve already running — attaching (will not manage).');
      this.owned = false;
      return;
    }
    if (!this.config.manageProcess) {
      throw new Error(
        `No docling-serve at ${this.config.baseUrl} and DOCLING_MANAGE_PROCESS is disabled.`,
      );
    }
    this.spawn();
    await this.waitUntilReady();
    this.owned = true;
  }

  private spawn(): void {
    const { hostname, port } = new URL(this.config.baseUrl);
    // Resolve the bundled binary when packaged; a Finder-launched .app does not
    // inherit the user's shell PATH, so a bare `docling-serve` would ENOENT (see
    // resolveSidecarCommand). Falls back to the PATH name in dev.
    const command = this.resolveCommand('docling-serve');
    this.log.info(`Spawning \`${command} run\`…`);
    // When the app has a persistent model store, serve fully OFFLINE against it:
    // point docling-serve at the downloaded artifacts and forbid any HF network
    // call (the models were fetched by the first-run download, not at serve time).
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.config.modelsDir) {
      env.DOCLING_SERVE_ARTIFACTS_PATH = this.config.modelsDir;
      env.HF_HUB_OFFLINE = '1';
      env.TRANSFORMERS_OFFLINE = '1';
      // Load models lazily, not at boot: the daemon comes up reliably even if the
      // store is mid-download, and a genuinely missing model surfaces as a clean
      // per-conversion error instead of a 60s hung readiness wait.
      env.DOCLING_SERVE_LOAD_MODELS_AT_BOOT = '0';
    }
    this.child = this.spawnImpl(command, ['run', '--host', hostname, '--port', port || '5001'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr?.on('data', (d: Buffer) => this.log.warn(`[docling] ${d.toString().trim()}`));
    // A spawn failure (ENOENT — the binary isn't on PATH) emits an `error` event;
    // WITHOUT this listener it is an *uncaught* exception that crashes the Electron
    // main process. Record it so the readiness wait can reject cleanly.
    this.child.on('error', (err: Error) => {
      this.spawnError = err;
      this.child = undefined;
      this.log.error(`Failed to spawn docling-serve: ${err.message}`);
    });
    this.child.on('exit', (code) => {
      if (this.owned) this.log.error(`docling-serve exited (code ${code ?? 'null'}).`);
      this.child = undefined;
    });
  }

  private async waitUntilReady(timeoutMs = 60_000, intervalMs = 750): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.spawnError) throw new Error(`Failed to spawn docling-serve: ${this.spawnError.message}`);
      if (await this.isHealthy()) {
        this.log.info('docling-serve is ready.');
        return;
      }
      await delay(intervalMs);
    }
    throw new Error(`docling-serve did not become ready within ${timeoutMs}ms.`);
  }

  async stop(): Promise<void> {
    if (!this.owned || !this.child) return;
    this.log.info('Stopping owned `docling-serve`…');
    const child = this.child;
    child.kill('SIGTERM');
    const exited = new Promise<'exit'>((resolve) => child.once('exit', () => resolve('exit')));
    const timedOut = delay(5_000).then(() => 'timeout' as const);
    if ((await Promise.race([exited, timedOut])) === 'timeout') {
      this.log.warn('docling-serve did not exit; sending SIGKILL.');
      child.kill('SIGKILL');
    }
    this.child = undefined;
    this.owned = false;
  }
}

/**
 * Lifecycle manager for the bundled `docling-serve` sidecar — same attach/spawn/
 * stop pattern as the Ollama process manager. docling-serve is Python; it ships
 * as a local subprocess (PRD §16.4).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { IngestConfig } from './types.js';

export interface IngestProcessLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: IngestProcessLogger = { info: () => {}, warn: () => {}, error: () => {} };

export class DoclingProcess {
  private child: ChildProcess | undefined;
  private owned = false;

  constructor(
    private readonly config: IngestConfig,
    private readonly log: IngestProcessLogger = noopLogger,
  ) {}

  get isOwned(): boolean {
    return this.owned;
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
    this.log.info('Spawning `docling-serve run`…');
    // Assumes `docling-serve` is on PATH (bundled with the app).
    this.child = spawn('docling-serve', ['run', '--host', hostname, '--port', port || '5001'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr?.on('data', (d: Buffer) => this.log.warn(`[docling] ${d.toString().trim()}`));
    this.child.on('exit', (code) => {
      if (this.owned) this.log.error(`docling-serve exited (code ${code ?? 'null'}).`);
      this.child = undefined;
    });
  }

  private async waitUntilReady(timeoutMs = 60_000, intervalMs = 750): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
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

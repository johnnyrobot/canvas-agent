/**
 * Lifecycle manager for the bundled `ollama serve` sidecar.
 *
 * Behavior:
 *  - If Ollama is already healthy (user/another process started it), we ATTACH
 *    and never kill it on shutdown.
 *  - Otherwise, if `manageProcess` is enabled, we spawn `ollama serve`, OWN it,
 *    and terminate it on `stop()`.
 *  - On `start()` we warm-load the model(s) so the first user request doesn't pay
 *    the multi-second cold load (PRD §15.1/§21).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { LLMConfig } from './types.js';
import { uniqueModels } from './config.js';
import { resolveSidecarCommand } from '../runtime/bundled-resources.js';

export interface OllamaProcessLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: OllamaProcessLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Injection seam for `child_process.spawn` so the lifecycle is unit-testable. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export class OllamaProcess {
  private child: ChildProcess | undefined;
  private owned = false;
  /** Set by the child's `error` event (e.g. ENOENT when the binary isn't on PATH). */
  private spawnError: Error | undefined;

  constructor(
    private readonly config: LLMConfig,
    private readonly log: OllamaProcessLogger = noopLogger,
    private readonly spawnImpl: SpawnLike = spawn,
    /** Resolve the `ollama` command — bundled abs path when packaged, else PATH. */
    private readonly resolveCommand: (name: string) => string = resolveSidecarCommand,
  ) {}

  /** Whether this manager spawned (and therefore owns) the daemon. */
  get isOwned(): boolean {
    return this.owned;
  }

  /** Ping the native `/api/version` endpoint. */
  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(this.config.nativeUrl + '/api/version', {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Ensure a healthy daemon is reachable, spawning one if permitted. */
  async ensureRunning(): Promise<void> {
    if (await this.isHealthy()) {
      this.log.info('Ollama already running — attaching (will not manage).');
      this.owned = false;
      return;
    }
    if (!this.config.manageProcess) {
      throw new Error(
        `No Ollama daemon at ${this.config.nativeUrl} and LLM_MANAGE_PROCESS is disabled.`,
      );
    }
    this.spawn();
    await this.waitUntilReady();
    this.owned = true;
  }

  private spawn(): void {
    // Resolve the bundled binary when packaged; a Finder-launched .app does not
    // inherit the user's shell PATH, so a bare `ollama` would ENOENT (see
    // resolveSidecarCommand). Falls back to the PATH name in dev.
    const command = this.resolveCommand('ollama');
    this.log.info(`Spawning \`${command} serve\`…`);
    this.spawnError = undefined;
    this.child = this.spawnImpl(command, ['serve'], {
      env: {
        ...process.env,
        OLLAMA_HOST: this.config.ollamaHost,
        OLLAMA_NUM_PARALLEL: String(this.config.numParallel),
        OLLAMA_KEEP_ALIVE: this.config.keepAlive,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr?.on('data', (d: Buffer) => this.log.warn(`[ollama] ${d.toString().trim()}`));
    // A spawn failure (ENOENT — the binary isn't on PATH, e.g. a Finder-launched
    // .app) emits an `error` event; WITHOUT this listener it is an *uncaught*
    // exception that crashes the Electron main process. Record it so the readiness
    // wait can reject cleanly and the caller can degrade gracefully.
    this.child.on('error', (err: Error) => {
      this.spawnError = err;
      this.child = undefined;
      this.log.error(`Failed to spawn ollama serve: ${err.message}`);
    });
    this.child.on('exit', (code) => {
      if (this.owned) this.log.error(`ollama serve exited (code ${code ?? 'null'}).`);
      this.child = undefined;
    });
  }

  private async waitUntilReady(timeoutMs = 30_000, intervalMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.spawnError) throw new Error(`Failed to spawn ollama serve: ${this.spawnError.message}`);
      if (await this.isHealthy()) {
        this.log.info('Ollama is ready.');
        return;
      }
      await delay(intervalMs);
    }
    throw new Error(`Ollama did not become ready within ${timeoutMs}ms.`);
  }

  /** Preload models into memory so the first real request is warm. */
  async warmLoad(models: string[] = uniqueModels(this.config)): Promise<void> {
    for (const model of models) {
      try {
        // An empty-prompt generate loads the model and honors keep_alive.
        await fetch(this.config.nativeUrl + '/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: this.config.keepAlive }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });
        this.log.info(`Warm-loaded ${model}.`);
      } catch (err) {
        this.log.warn(`Warm-load of ${model} failed: ${(err as Error).message}`);
      }
    }
  }

  /** Stop the daemon if (and only if) we own it. */
  async stop(): Promise<void> {
    if (!this.owned || !this.child) return;
    this.log.info('Stopping owned `ollama serve`…');
    const child = this.child;
    child.kill('SIGTERM');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const timedOut = delay(5_000).then(() => 'timeout' as const);
    if ((await Promise.race([exited.then(() => 'exit' as const), timedOut])) === 'timeout') {
      this.log.warn('ollama serve did not exit; sending SIGKILL.');
      child.kill('SIGKILL');
    }
    this.child = undefined;
    this.owned = false;
  }
}

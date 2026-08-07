/**
 * The `ollama serve` sidecar adapter.
 *
 * Attach/spawn/stop/respawn is NOT here — it is the shared `SidecarLifecycle`
 * (`src/sidecar`, ADR-0004). This file supplies only what is specific to
 * Ollama: the health check, the spawn spec, and the model warm load.
 *
 * Behavior (unchanged, and now shared with Docling):
 *  - If Ollama is already healthy (user/another process started it), we ATTACH
 *    and never kill it on shutdown.
 *  - Otherwise, if `manageProcess` is enabled, we spawn `ollama serve`, OWN it,
 *    and terminate it on `stop()`.
 *  - On `start()` we warm-load the model(s) so the first user request doesn't pay
 *    the multi-second cold load (PRD §15.1/§21).
 */
import type { LLMConfig } from './types.js';
import { uniqueModels } from './config.js';
import { resolveSidecarCommand } from '../runtime/bundled-resources.js';
import {
  SidecarLifecycle,
  type RespawnPolicy,
  type SidecarLogger,
  type SpawnLike,
  type SpawnSpec,
} from '../sidecar/index.js';

// Re-exported so callers and tests keep importing the process seams from the
// sidecar they belong to, rather than reaching into `src/sidecar` directly.
export type { RespawnPolicy, SidecarLogger, SpawnLike };

export class OllamaProcess extends SidecarLifecycle {
  constructor(
    private readonly config: LLMConfig,
    log?: SidecarLogger,
    spawnImpl?: SpawnLike,
    /** Resolve the `ollama` command — bundled abs path when packaged, else PATH. */
    private readonly resolveCommand: (name: string) => string = resolveSidecarCommand,
    respawnPolicy?: RespawnPolicy,
  ) {
    super({
      displayName: 'Ollama',
      commandLabel: 'ollama serve',
      logTag: 'ollama',
      unmanagedMessage:
        `No Ollama daemon at ${config.nativeUrl} and LLM_MANAGE_PROCESS is disabled.`,
      manageProcess: config.manageProcess,
      ...(log ? { log } : {}),
      ...(spawnImpl ? { spawnImpl } : {}),
      ...(respawnPolicy ? { respawnPolicy } : {}),
    });
  }

  /** Ping the native `/api/version` endpoint. */
  override async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(this.config.nativeUrl + '/api/version', {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  protected spawnSpec(): SpawnSpec {
    // Resolve the bundled binary when packaged; a Finder-launched .app does not
    // inherit the user's shell PATH, so a bare `ollama` would ENOENT (see
    // resolveSidecarCommand). Falls back to the PATH name in dev.
    return {
      command: this.resolveCommand('ollama'),
      args: ['serve'],
      env: {
        ...process.env,
        OLLAMA_HOST: this.config.ollamaHost,
        OLLAMA_NUM_PARALLEL: String(this.config.numParallel),
        OLLAMA_KEEP_ALIVE: this.config.keepAlive,
      },
    };
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
}

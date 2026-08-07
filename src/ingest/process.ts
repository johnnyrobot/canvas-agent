/**
 * The `docling-serve` sidecar adapter.
 *
 * Attach/spawn/stop/respawn is NOT here — it is the shared `SidecarLifecycle`
 * (`src/sidecar`, ADR-0004). This file supplies only what is specific to
 * Docling: the health check, the spawn spec, and the model-store probe.
 * docling-serve is Python; it ships as a local subprocess (PRD §16.4).
 */
import { existsSync, readdirSync } from 'node:fs';
import type { IngestConfig } from './types.js';
import { resolveSidecarCommand } from '../runtime/bundled-resources.js';
import {
  SidecarLifecycle,
  type SidecarLogger,
  type SpawnLike,
  type SpawnSpec,
} from '../sidecar/index.js';

// Re-exported so callers and tests keep importing the process seams from the
// sidecar they belong to, rather than reaching into `src/sidecar` directly.
export type { SidecarLogger, SpawnLike };

/** docling-serve's readiness wait is longer than the default: Python + model boot. */
const READY_TIMEOUT_MS = 60_000;
const READY_INTERVAL_MS = 750;

export class DoclingProcess extends SidecarLifecycle {
  constructor(
    private readonly config: IngestConfig,
    log?: SidecarLogger,
    spawnImpl?: SpawnLike,
    /** Resolve the `docling-serve` command — bundled abs path when packaged, else PATH. */
    private readonly resolveCommand: (name: string) => string = resolveSidecarCommand,
  ) {
    super({
      displayName: 'docling-serve',
      commandLabel: 'docling-serve',
      logTag: 'docling',
      unmanagedMessage:
        `No docling-serve at ${config.baseUrl} and DOCLING_MANAGE_PROCESS is disabled.`,
      manageProcess: config.manageProcess,
      readyTimeoutMs: READY_TIMEOUT_MS,
      readyIntervalMs: READY_INTERVAL_MS,
      ...(log ? { log } : {}),
      ...(spawnImpl ? { spawnImpl } : {}),
    });
  }

  /**
   * Whether the downloaded conversion models are present on disk. Only meaningful
   * when `config.modelsDir` is set (the packaged app's per-user store); without
   * it we can't tell (the bundled launcher may have its own `models/`), so we
   * optimistically report `true` and let conversion surface any real gap.
   *
   * Stays here rather than moving into the shared lifecycle: this is first-run
   * provisioning, not lifecycle (ADR-0004).
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
  override async isHealthy(): Promise<boolean> {
    try {
      await fetch(this.config.baseUrl + this.config.healthPath, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  protected spawnSpec(): SpawnSpec {
    const { hostname, port } = new URL(this.config.baseUrl);
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
    // Resolve the bundled binary when packaged; a Finder-launched .app does not
    // inherit the user's shell PATH, so a bare `docling-serve` would ENOENT (see
    // resolveSidecarCommand). Falls back to the PATH name in dev.
    return {
      command: this.resolveCommand('docling-serve'),
      args: ['run', '--host', hostname, '--port', port || '5001'],
      env,
    };
  }
}

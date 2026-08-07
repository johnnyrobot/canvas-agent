/**
 * The lifecycle both local sidecars share (ADR-0004).
 *
 * Attach-if-running / spawn-if-not / stop-with-TERM-then-KILL was implemented
 * twice — once for `ollama serve`, once for `docling-serve` — with the same
 * algorithm. That duplication is why the respawn supervisor built for Ollama
 * never reached Docling. It lives here now, once.
 *
 * `src/sidecar/` is a LEAF module: it imports nothing from `src/runtime/` (the
 * composition root, which must stay a consumer) and nothing from `src/llm/` or
 * `src/ingest/`. Each sidecar supplies only two things — a health check and a
 * spawn spec — by extending `SidecarLifecycle`.
 *
 * What deliberately does NOT live here: Ollama's `warmLoad` and Docling's
 * `modelsPresent`. Warm-loading is a model concern and model presence is
 * first-run provisioning; neither is lifecycle, and folding them in would make
 * the adapter surface grow with every sidecar-specific need.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export interface SidecarLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const noopLogger: SidecarLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Injection seam for `child_process.spawn` so the lifecycle is unit-testable. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Everything needed to start one sidecar, re-read on every (re)spawn. */
export interface SpawnSpec {
  /** Resolved command — a bundled absolute path when packaged, else a PATH name. */
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}

/** Bound on how often a crashed sidecar is respawned before we give up (anti crash-loop). */
export interface RespawnPolicy {
  /** Max respawns permitted within `windowMs`. */
  maxRespawns: number;
  /** Sliding window (ms) the respawn count is measured over. */
  windowMs: number;
}

const DEFAULT_RESPAWN_POLICY: RespawnPolicy = { maxRespawns: 3, windowMs: 60_000 };

export interface SidecarLifecycleOptions {
  /** Prose subject in status lines: "Ollama is ready." */
  displayName: string;
  /** The command phrase in spawn/exit/stop lines: "ollama serve". */
  commandLabel: string;
  /** Prefix on forwarded stderr: `[ollama] …`. */
  logTag: string;
  /** Exact error when the sidecar is down and we are not allowed to start it. */
  unmanagedMessage: string;
  /** False ⇒ attach or fail: never spawn, never respawn. */
  manageProcess: boolean;
  /** How long to wait for the sidecar to answer after a spawn. */
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  /** How long a SIGTERM'd child gets before SIGKILL. */
  stopGraceMs?: number;
  respawnPolicy?: RespawnPolicy;
  log?: SidecarLogger;
  spawnImpl?: SpawnLike;
}

/**
 * Attach/spawn/stop for one local sidecar process.
 *
 * Subclass it and supply the two adapter members — `isHealthy()` and
 * `spawnSpec()`. Everything else is shared.
 */
export abstract class SidecarLifecycle {
  private child: ChildProcess | undefined;
  private owned = false;
  /** Set by the child's `error` event (e.g. ENOENT when the binary isn't on PATH). */
  private spawnError: Error | undefined;
  /** Epoch-ms of recent respawns, pruned to the policy window (crash-loop guard). */
  private respawns: number[] = [];
  /** Memoized in-flight start — see `ensureRunning`. */
  private starting: Promise<void> | undefined;

  private readonly opts: Required<SidecarLifecycleOptions>;
  protected readonly log: SidecarLogger;

  constructor(options: SidecarLifecycleOptions) {
    this.opts = {
      readyTimeoutMs: 30_000,
      readyIntervalMs: 500,
      stopGraceMs: 5_000,
      respawnPolicy: DEFAULT_RESPAWN_POLICY,
      log: noopLogger,
      spawnImpl: nodeSpawn,
      ...options,
    };
    this.log = this.opts.log;
  }

  // ── The adapter surface each sidecar supplies ──────────────────────────────

  /** Is a server listening? Public because callers probe health directly. */
  abstract isHealthy(): Promise<boolean>;

  /**
   * How to start this sidecar. Called at spawn time, not construction time, so
   * config-derived env (e.g. Docling's offline artifacts path) is never stale.
   */
  protected abstract spawnSpec(): SpawnSpec;

  // ── Shared lifecycle ───────────────────────────────────────────────────────

  /** Whether this manager spawned (and therefore owns) the process. */
  get isOwned(): boolean {
    return this.owned;
  }

  /**
   * Ensure a healthy sidecar is reachable, spawning one if permitted.
   *
   * MEMOIZED on the in-flight promise, so concurrent callers spawn once and a
   * settled successful start is not redone. A FAILED start clears the memo so a
   * later call can retry. This guard used to live one layer up, in
   * `DoclingSidecar.ensureStarted()`; moving it down here is how the LLM
   * sidecar gains it (ADR-0004) — `OllamaSidecar.start()` previously re-ran the
   * whole attach/spawn probe on every call.
   *
   * A start that succeeded stays memoized even if the process later dies; that
   * case is `ensureAlive`'s job, not this one's.
   */
  ensureRunning(): Promise<void> {
    if (!this.starting) {
      this.starting = this.attachOrSpawn().catch((err: unknown) => {
        this.starting = undefined;
        throw err;
      });
    }
    return this.starting;
  }

  private async attachOrSpawn(): Promise<void> {
    if (await this.isHealthy()) {
      this.log.info(`${this.opts.displayName} already running — attaching (will not manage).`);
      this.owned = false;
      return;
    }
    if (!this.opts.manageProcess) throw new Error(this.opts.unmanagedMessage);
    this.spawn();
    await this.waitUntilReady();
    this.owned = true;
  }

  /**
   * Lazily make sure the sidecar is still up before a request, respawning a
   * crashed one (the `exit` handler only nulls `this.child`, so without this a
   * mid-session crash leaves the sidecar dead until app restart). Cheap on the
   * happy path — one fast local health ping — and bounded by the respawn policy
   * so a crash-looping process surfaces a clear error instead of restarting
   * forever.
   *
   * Honors attach-don't-kill: a healthy process (ours or the user's) is never
   * touched, and when `manageProcess` is off we never start one — the call
   * fails naturally.
   */
  async ensureAlive(): Promise<void> {
    if (!this.opts.manageProcess) return; // not ours to manage; let the request fail naturally
    if (await this.isHealthy()) return; // up (owned or attached) — leave it alone
    this.recordRespawn(); // throws once the crash-loop budget is spent
    this.log.warn(`${this.opts.displayName} is unreachable mid-session — respawning.`);
    // Reap any child we still hold before replacing it. The sidecar is
    // unreachable but its process may still be alive (hung, not yet exited);
    // dropping the reference alone would orphan it and let it fight the
    // replacement for the port. Best-effort — if the `exit` handler already
    // nulled it, there is nothing to kill.
    const stale = this.child;
    this.child = undefined;
    if (stale) stale.kill('SIGKILL');
    this.owned = false;
    this.spawn();
    await this.waitUntilReady();
    this.owned = true;
    this.log.info(`${this.opts.displayName} respawned.`);
  }

  /** Stop the sidecar if (and only if) we own it. Safe to call on shutdown. */
  async stop(): Promise<void> {
    this.starting = undefined;
    if (!this.owned || !this.child) return;
    this.log.info(`Stopping owned \`${this.opts.commandLabel}\`…`);
    const child = this.child;
    child.kill('SIGTERM');
    const exited = new Promise<'exit'>((resolve) => child.once('exit', () => resolve('exit')));
    const timedOut = delay(this.opts.stopGraceMs).then(() => 'timeout' as const);
    if ((await Promise.race([exited, timedOut])) === 'timeout') {
      this.log.warn(`${this.opts.commandLabel} did not exit; sending SIGKILL.`);
      child.kill('SIGKILL');
    }
    this.child = undefined;
    this.owned = false;
  }

  /** Record a respawn attempt against the sliding-window budget; throw when exhausted. */
  private recordRespawn(): void {
    const { maxRespawns, windowMs } = this.opts.respawnPolicy;
    const now = Date.now();
    this.respawns = this.respawns.filter((t) => now - t < windowMs);
    if (this.respawns.length >= maxRespawns) {
      throw new Error(
        `${this.opts.displayName} keeps dying — exceeded ${maxRespawns} respawns ` +
          `within ${windowMs}ms; giving up.`,
      );
    }
    this.respawns.push(now);
  }

  private spawn(): void {
    const spec = this.spawnSpec();
    this.log.info(`Spawning \`${spec.command} ${spec.args.join(' ')}\`…`);
    this.spawnError = undefined;
    const child = this.opts.spawnImpl(spec.command, spec.args, {
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) => this.log.warn(`[${this.opts.logTag}] ${d.toString().trim()}`));
    // A spawn failure (ENOENT — the binary isn't on PATH, e.g. a Finder-launched
    // .app) emits an `error` event; WITHOUT this listener it is an *uncaught*
    // exception that crashes the Electron main process. Record it so the
    // readiness wait can reject cleanly and the caller can degrade gracefully.
    child.on('error', (err: Error) => {
      this.spawnError = err;
      // Only clear our handle if `child` is still the tracked process — a late
      // event from a replaced child must not wipe out its live replacement.
      if (this.child === child) this.child = undefined;
      this.log.error(`Failed to spawn ${this.opts.commandLabel}: ${err.message}`);
    });
    child.on('exit', (code) => {
      if (this.owned) this.log.error(`${this.opts.commandLabel} exited (code ${code ?? 'null'}).`);
      // Guard against a stale `exit` from a process we have already respawned: a
      // queued event from the old child could otherwise null out the new one,
      // leaving stop() unable to terminate the live process (it would leak).
      if (this.child === child) this.child = undefined;
    });
  }

  private async waitUntilReady(): Promise<void> {
    const { readyTimeoutMs, readyIntervalMs, commandLabel, displayName } = this.opts;
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (this.spawnError) throw new Error(`Failed to spawn ${commandLabel}: ${this.spawnError.message}`);
      if (await this.isHealthy()) {
        this.log.info(`${displayName} is ready.`);
        return;
      }
      await delay(readyIntervalMs);
    }
    throw new Error(`${displayName} did not become ready within ${readyTimeoutMs}ms.`);
  }
}

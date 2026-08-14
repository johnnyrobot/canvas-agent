/**
 * The local LLM sidecar facade: ties the `ollama serve` lifecycle to the chat
 * client, serializes requests for the single-user app, and exposes the
 * role-based API the orchestrator consumes (PRD §15).
 */
import {
  type ChatChunk,
  type ChatOptions,
  type ChatResult,
  type DescribeImageOptions,
  type LLMConfig,
  type ModelSetStatus,
  type ModelStatusState,
  type PullProgress,
  type RequiredModelRole,
  type RequiredModelStatus,
  missingCapabilities,
  REQUIRED_ROLES,
  SATISFYING_MODEL_STATES,
} from './types.js';
import { loadLLMConfig, modelTagsToPull, reportedModels, type Env } from './config.js';
import { OllamaClient, OllamaError, type FetchLike } from './client.js';
import { OllamaProcess, type SidecarLogger } from './process.js';
import { Mutex } from './mutex.js';
import { toRawBase64 } from './payload.js';

/** Max DECODED image size `describeImage` accepts (memory/latency guard, PRD §10). */
export const MAX_DESCRIBE_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB

/** Approximate decoded byte length of a base64 image (data: prefix stripped). No allocation. */
export function decodedBase64Bytes(image: string): number {
  const raw = toRawBase64(image).trim();
  if (raw.length === 0) return 0;
  const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((raw.length * 3) / 4) - padding);
}

export class OllamaJsonError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'OllamaJsonError';
  }
}

export interface CreateSidecarOptions {
  env?: Env;
  logger?: SidecarLogger;
  /** Injectable transport for the chat client (tests pass a fake; default global `fetch`). */
  fetch?: FetchLike;
  /** Injectable daemon lifecycle manager (tests pass a double; default a real `OllamaProcess`). */
  process?: OllamaProcess;
}

export class OllamaSidecar {
  readonly config: LLMConfig;
  private readonly client: OllamaClient;
  private readonly process: OllamaProcess;
  private readonly mutex = new Mutex();

  constructor(options: CreateSidecarOptions = {}) {
    this.config = loadLLMConfig(options.env);
    this.client = new OllamaClient(this.config, options.fetch);
    this.process = options.process ?? new OllamaProcess(this.config, options.logger);
  }

  /**
   * Ensure the daemon is running and the model(s) are warm.
   *
   * `ensureRunning` is memoized inside the shared lifecycle (ADR-0004), so
   * repeat calls no longer re-run the attach/spawn probe. `warmLoad` is not
   * memoized — it is a model concern, not lifecycle, and re-warming an
   * already-loaded model is a cheap no-op that also refreshes `keep_alive`.
   */
  async start(): Promise<void> {
    await this.process.ensureRunning();
    await this.process.warmLoad();
  }

  /** Stop the daemon if this process owns it. Safe to call on shutdown. */
  async stop(): Promise<void> {
    await this.process.stop();
  }

  isHealthy(): Promise<boolean> {
    return this.process.isHealthy();
  }

  /**
   * Probe how each REQUIRED model stands (ADR-0009: text and vision) — present,
   * absent, present-but-incapable, or switched off (ADR-0010).
   *
   * Reported per required ROLE, not as one aggregate answer, so the UI can say
   * *which* model is unsatisfied and *why* the recoveries differ. `ready` is the
   * conjunction: one model satisfied and the other not is NOT ready — a partial
   * install that read as ready is precisely how alt-text suggestion would fail
   * after setup completes, on a machine the user believes is fully provisioned.
   *
   * Every required role is reported whether or not this configuration requires
   * it. A role dropped from the payload reads to the UI as "nothing missing",
   * which is the silent hole the `disabled` state exists to close.
   */
  async modelStatus(): Promise<ModelSetStatus> {
    // An unreachable daemon means nothing is known to be installed, which reads
    // as everything missing — never as ready.
    const installed = await this.client.localModelTags().catch(() => new Set<string>());
    const models: RequiredModelStatus[] = await Promise.all(
      reportedModels(this.config).map(async ({ role, tag, required }) => {
        if (!required) return { role, tag, status: 'disabled' as const };
        // Not installed is two different facts. For a role provisioned at first
        // run it is a broken install; for one fetched on demand it is simply a
        // download nobody has asked for yet (ADR-0012).
        if (!installed.has(tag)) {
          const absent: ModelStatusState =
            REQUIRED_ROLES[role].provisioning === 'first-use' ? 'deferred' : 'missing';
          return { role, tag, status: absent };
        }
        return { role, tag, status: await this.capabilityStatus(role, tag) };
      }),
    );
    // `deferred` satisfies the set for the same reason `disabled` does: nothing
    // is wrong. The weights are one sized, offered download away, taken at the
    // moment the capability is first asked for (ADR-0012).
    return { ready: models.every((m) => SATISFYING_MODEL_STATES.has(m.status)), models };
  }

  /**
   * Whether an INSTALLED tag can do `role`'s job.
   *
   * A probe that throws falls back to `ready` — the documented asymmetry of
   * ADR-0010. An unknown capability is not evidence of incapability, and
   * reporting `incapable` would tell a user with a correct configuration to
   * change it on the strength of a daemon hiccup, with no retry that clears it
   * (the recovery for `incapable` is advice, not a command). An empty
   * capabilities array is a real answer and is not a failure.
   */
  private async capabilityStatus(role: RequiredModelRole, tag: string): Promise<ModelStatusState> {
    let capabilities: string[];
    try {
      capabilities = await this.client.modelCapabilities(tag);
    } catch {
      return 'ready';
    }
    return missingCapabilities(role, capabilities).length === 0 ? 'ready' : 'incapable';
  }

  /**
   * Download the required models (ADR-0009) into the local Ollama, reporting
   * progress. First-run provisioning: the bundled daemon is brought up if
   * needed, then each required tag is pulled via `/api/pull`, in sequence.
   *
   * The tags are deduplicated first, so a config that points both required roles
   * at one multimodal tag is one download and not two identical pulls. (The
   * shipping defaults are two distinct tags since #33.) Each progress line
   * names its model, because `percent` restarts per pull and only the caller can
   * aggregate across the set. Resolves once every pull completes; rejects on a
   * pull error (e.g. an unknown tag or a network failure) without attempting the
   * rest, leaving the status probe to report honestly what is still missing. Not
   * serialized against chat — there is nothing to chat with until this finishes.
   */
  async pullModel(onProgress?: (p: PullProgress) => void): Promise<void> {
    await this.pullTags(modelTagsToPull(this.config, 'first-run'), onProgress);
  }

  /**
   * Download the models this configuration defers to first use (ADR-0012) —
   * today, the vision model, ~3.3 GB.
   *
   * Called when the instructor first asks for something that needs the
   * capability, never inside a turn: a running turn is a streaming interaction
   * being watched, and blocking one for the minutes this takes reads as a hang.
   *
   * Downloads NOTHING when the role is not required — an operator who set
   * `LLM_VISION_ENABLED=false` chose to have no vision, and a download that
   * appears anyway is the multi-gigabyte surprise the derived required set
   * exists to prevent. Idempotent in practice: Ollama re-pulling an installed
   * tag reports `success` almost immediately.
   */
  async pullVisionModel(onProgress?: (p: PullProgress) => void): Promise<void> {
    await this.pullTags(modelTagsToPull(this.config, 'first-use'), onProgress);
  }

  /**
   * Pull each tag in sequence, naming the model on every progress line.
   *
   * Shared by both pull entry points so they cannot drift on the details that
   * matter to the bar above them: the daemon is brought up first; `percent`
   * restarts per pull, so only a caller that knows the tag can aggregate across
   * a set; and a failure stops the sequence rather than pressing on, leaving the
   * status probe to report honestly what is still absent. Nothing is serialized
   * against chat — there is nothing to chat with until a first-run pull
   * finishes, and a deferred pull is gated by the UI before the turn starts.
   */
  private async pullTags(tags: readonly string[], onProgress?: (p: PullProgress) => void): Promise<void> {
    if (tags.length === 0) return;
    await this.process.ensureAlive(); // make sure the bundled `ollama serve` is up
    for (const tag of tags) {
      for await (const raw of this.client.pullModel(tag)) {
        onProgress?.({ ...normalizePullProgress(raw), model: tag });
      }
    }
  }

  /** Non-streaming chat, serialized against other heavy calls. */
  chat(opts: ChatOptions): Promise<ChatResult> {
    return this.mutex.run(async () => {
      // Respawn a crashed daemon before the request so a mid-session Ollama exit
      // self-heals instead of failing every later call (no-op when healthy/unmanaged).
      await this.process.ensureAlive();
      return this.client.chat(opts);
    });
  }

  /** Streaming chat — holds the lock for the duration of the stream. */
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
    const release = await this.mutex.acquire();
    try {
      await this.process.ensureAlive();
      yield* this.client.chatStream(opts);
    } finally {
      release();
    }
  }

  /**
   * Chat constrained to JSON and parsed. Used for the structured ChangeLog
   * (PRD §15.4). Parsing failures throw `OllamaJsonError`; the caller (the
   * orchestrator) owns repair/retry and schema validation — the model output is
   * never trusted directly.
   */
  async chatJSON<T = unknown>(
    opts: ChatOptions & { schema?: Record<string, unknown> },
  ): Promise<T> {
    const format = opts.schema ?? 'json';
    const { schema: _schema, ...rest } = opts;
    const result = await this.chat({ ...rest, format });
    const text = stripCodeFences(result.content);
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new OllamaJsonError(`Model did not return valid JSON: ${(err as Error).message}`, result.content);
    }
  }

  /**
   * Draft alt text / a long description for a USER-SUPPLIED image via the local
   * vision model. The app never fetches images (PRD §16.3); `image` must be data
   * the user provided.
   */
  async describeImage(opts: DescribeImageOptions): Promise<ChatResult> {
    if (!this.config.visionEnabled) {
      throw new OllamaError('Vision is disabled (LLM_VISION_ENABLED=false).');
    }
    // Size guard (PRD §10): reject an oversized blob BEFORE it flows verbatim into
    // the request body — an unbounded image would otherwise hang/OOM the on-device
    // GPU. Bounded by a single-user device, but cheap to stop and gives a clear error.
    const bytes = decodedBase64Bytes(opts.image);
    if (bytes > MAX_DESCRIBE_IMAGE_BYTES) {
      throw new OllamaError(
        `Image is too large for on-device description (~${Math.round(bytes / 1024 / 1024)} MB decoded, ` +
          `limit ${Math.round(MAX_DESCRIBE_IMAGE_BYTES / 1024 / 1024)} MB). Resize or compress it first.`,
      );
    }
    const role = opts.role ?? 'vision';
    try {
      return await this.chat({
        role,
        ...(opts.signal ? { signal: opts.signal } : {}),
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              { type: 'image_url', image_url: { url: opts.image } },
            ],
          },
        ],
      });
    } catch (err) {
      // The in-turn guard of ADR-0012. The pull is offered BEFORE a turn starts,
      // but a pre-turn check only covers the paths someone thought of — and what
      // an instructor sees on a path nobody thought of must not be
      // `Ollama /api/chat returned 404`. Narrow on purpose: only an
      // absent-model answer is rewritten, so an unrelated failure is never
      // disguised as a download that would fix nothing.
      const tag = this.config.models[role];
      if (isModelAbsent(err, tag)) throw new ModelNotFetchedError(tag);
      throw err;
    }
  }
}

/**
 * A required model that has not been fetched yet — the `deferred` state, hit
 * from inside a turn instead of from the affordance that should have caught it.
 *
 * Its own type, not a message: the caller has to be able to tell this from every
 * other failure, because this is the one it can offer to FIX. `tag` is the model
 * to download.
 */
export class ModelNotFetchedError extends OllamaError {
  constructor(readonly tag: string) {
    super(
      `${tag} has not been downloaded yet. Alt-text suggestion downloads it the first time you use it — ` +
        `start the download and try again. Alt-text detection does not need it.`,
      404,
    );
    // Mirrors `MODEL_NOT_FETCHED` in `src/contracts` — the one thing that
    // survives IPC, and what the UI matches on to offer the download.
    this.name = 'ModelNotFetchedError';
  }
}

/**
 * Whether `err` is Ollama saying it does not have this model.
 *
 * Matched on the status AND the phrasing rather than status alone: a 404 from a
 * misconfigured base URL is a different problem with a different fix, and
 * offering a model download for it would send someone off to wait on gigabytes
 * that change nothing.
 */
function isModelAbsent(err: unknown, tag: string): boolean {
  // 404 and not 400, deliberately. The `Ollama /api/chat returned 400` that #39
  // and ADR-0010 quote is a DIFFERENT failure: a model that is installed and
  // cannot see, which is `incapable` — and the recovery for that is to change
  // the tag, never to download the one already on disk. Rewriting a 400 here
  // would send an instructor to wait on gigabytes that cannot help them. An
  // absent model is Ollama's 404.
  if (!(err instanceof OllamaError) || err.status !== 404) return false;
  // The transport puts the status in `message` and the daemon's own words in
  // `body` (`post()` in client.ts) — so the phrasing to match on is in `body`,
  // and reading only `message` would leave this guard permanently unreachable.
  const said = `${err.message} ${err.body ?? ''}`.toLowerCase();
  return said.includes('not found') || said.includes('try pulling') || said.includes(tag.toLowerCase());
}

/** Normalize a native `/api/pull` progress line into the layer-agnostic `PullProgress`. */
export function normalizePullProgress(raw: {
  status?: string;
  completed?: number;
  total?: number;
}): PullProgress {
  const p: PullProgress = { status: raw.status ?? 'working' };
  if (typeof raw.completed === 'number') p.completed = raw.completed;
  if (typeof raw.total === 'number') p.total = raw.total;
  if (typeof raw.completed === 'number' && typeof raw.total === 'number' && raw.total > 0) {
    p.percent = Math.min(100, Math.max(0, Math.round((raw.completed / raw.total) * 100)));
  }
  return p;
}

/** Strip a ```json … ``` (or ``` … ```) fence the model may have wrapped JSON in. */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function createOllamaSidecar(options?: CreateSidecarOptions): OllamaSidecar {
  return new OllamaSidecar(options);
}

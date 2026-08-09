/**
 * Public types for the local LLM (Ollama) inference sidecar.
 *
 * The product runs a single on-device model (via Ollama's MLX
 * engine) for text, vision and audio. There is NO cloud LLM and no external
 * API — see PRD §15.1 and the no-cloud constraint. Callers select a *role*,
 * never a hard-coded model string (PRD §15.1).
 */

/** Logical model roles. In v1 every role resolves to the same local model. */
export type ModelRole = 'text' | 'vision' | 'fast' | 'deep' | 'cheap';

export const MODEL_ROLES: readonly ModelRole[] = ['text', 'vision', 'fast', 'deep', 'cheap'];

/**
 * The roles the app actually provisions and gates readiness on (ADR-0009).
 *
 * `fast`, `deep` and `cheap` are tiering aliases nothing outside `example.ts`
 * calls; they are deliberately NOT provisioned, so pointing one of them at a
 * different tag can never trigger a multi-gigabyte first-run download.
 */
export const REQUIRED_MODEL_ROLES = ['text', 'vision'] as const satisfies readonly ModelRole[];

export type RequiredModelRole = (typeof REQUIRED_MODEL_ROLES)[number];

/**
 * What a required model can be, from the app's point of view (ADR-0010).
 *
 * `available: boolean` used to live here, and it could not express the state
 * that actually broke the flagship path: a tag that is installed and cannot do
 * the job its role needs. The four are exhaustive and mutually exclusive.
 *
 *   ready     — present, and reports every capability its role requires
 *   missing   — not in the local store; a download fixes it
 *   incapable — present, but cannot do this role's job. A download fixes
 *               NOTHING: the recovery is to point the role at another tag
 *   disabled  — the operator switched this capability off, so the role left the
 *               required set. Not an error, and not a reason to degrade
 */
export type ModelStatusState = 'ready' | 'missing' | 'incapable' | 'disabled';

/** How one required model stands, in the local Ollama store and by capability. */
export interface RequiredModelStatus {
  role: RequiredModelRole;
  tag: string;
  status: ModelStatusState;
}

/**
 * How the whole required set stands. `ready` is true only when EVERY required
 * model is satisfied — a partial install must never read as ready (ADR-0009),
 * and neither must an install that is complete but incapable (ADR-0010).
 *
 * A `disabled` role satisfies the set: it is not required, so gating on it would
 * hold the app hostage to a model nothing will call.
 */
export interface ModelSetStatus {
  ready: boolean;
  /** One entry per required role, in `REQUIRED_MODEL_ROLES` order. */
  models: RequiredModelStatus[];
}

/**
 * What each required ROLE demands of whatever tag fills it, as Ollama's
 * `/api/show` names capabilities (ADR-0010).
 *
 * Declared per role rather than per tag on purpose. A per-tag allowlist would
 * need editing every time `scripts/model-eval/` promotes a different vision
 * model — and a forgotten edit would be invisible, because the new tag would
 * simply go unchecked. Per role also catches what no allowlist can: an
 * operator's override pointing at a model that cannot do the job.
 *
 * `tools` on the text role is the half that is easy to miss: the orchestrator is
 * a tool-calling loop, so a text model without it fails deep inside a turn.
 */
export const ROLE_CAPABILITIES: Readonly<Record<RequiredModelRole, readonly string[]>> = {
  text: ['completion', 'tools'],
  vision: ['completion', 'vision'],
};

/** A piece of a multimodal message. */
export type ContentPart =
  | { type: 'text'; text: string }
  /** `url` may be a raw base64 string or a `data:<mime>;base64,...` data URL. */
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text, or content parts for multimodal (text + image) input. */
  content: string | ContentPart[];
  /** Set on an assistant turn that requested tools (echoed back into history). */
  toolCalls?: ToolCall[];
  /** Set on a `role: 'tool'` message — which tool produced this result. */
  toolName?: string;
}

/** A function/tool the model may call (native Ollama tool use). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool's arguments. */
  parameters: Record<string, unknown>;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatOptions {
  /** Which logical model to use. Defaults to `text`. */
  role?: ModelRole;
  messages: ChatMessage[];
  /** Sampling temperature; defaults to the configured value (low). */
  temperature?: number;
  /** Max tokens to generate (Ollama `num_predict`). */
  maxTokens?: number;
  /** Context window for this request (Ollama `num_ctx`). */
  numCtx?: number;
  /**
   * Constrain output. `'json'` forces valid JSON; an object is treated as a
   * JSON Schema (Ollama structured outputs). Used for the ChangeLog (PRD §15.4).
   */
  format?: 'json' | Record<string, unknown>;
  /** Enable the model's thinking/reasoning mode (model/version dependent). */
  think?: boolean;
  /** Tools the model may call this turn. */
  tools?: ToolDefinition[];
  /** Abort the in-flight request. */
  signal?: AbortSignal;
}

export interface ChatResult {
  /** The assistant's final text. */
  content: string;
  /** The resolved model tag that produced it. */
  model: string;
  /** Reasoning trace when `think` is enabled and the model returns one. */
  thinking?: string;
  /** Tools the model asked to call this turn (empty/undefined if none). */
  toolCalls?: ToolCall[];
  /**
   * Ollama's `done_reason` (e.g. `'stop'` | `'length'`). `'length'` means the
   * completion was truncated at `num_predict` — so a structured/ChangeLog draft
   * may be incomplete and must not be treated as final (C11). Absent when the
   * provider did not report one.
   */
  doneReason?: string;
  /** Raw provider response, for debugging / telemetry. */
  raw: unknown;
}

export interface ChatChunk {
  /** Incremental text delta. */
  delta: string;
  /** True on the final chunk. */
  done: boolean;
  /**
   * Tools the model asked to call this turn. Native Ollama streaming emits
   * `message.tool_calls` (usually on the final chunk); surfacing them here lets
   * the orchestrator's tool loop run under streaming exactly as it does for the
   * non-streaming `chat` path. Absent when the model is only emitting text.
   */
  toolCalls?: ToolCall[];
  /**
   * Ollama's `done_reason` for this generation, present only on the terminal
   * chunk (e.g. `'stop'` for a normal stop, `'length'` for a `num_predict`
   * truncation). Lets downstream tell a *finished* draft from a cut-off one —
   * a truncated alt-text/JSON draft must never be surfaced as complete (C11).
   */
  doneReason?: string;
}

export interface DescribeImageOptions {
  /** Raw base64 or a `data:` URL. */
  image: string;
  /** Instruction, e.g. "Write concise alt text (<=80 chars)…". */
  prompt: string;
  /** Defaults to the `vision` role. */
  role?: ModelRole;
  signal?: AbortSignal;
}

/** Resolved runtime configuration (see config.ts and PRD Appendix H). */
export interface LLMConfig {
  /** OpenAI-compatible base, e.g. http://localhost:11434/v1 (documented transport). */
  baseUrl: string;
  /** Native Ollama root (baseUrl without /v1), used internally for full control. */
  nativeUrl: string;
  /** `host:port` passed to `ollama serve`. */
  ollamaHost: string;
  /** Role → Ollama model tag. */
  models: Record<ModelRole, string>;
  /** Keep the model resident to avoid cold loads (Ollama `keep_alive`). */
  keepAlive: string;
  /** Default context window (Ollama `num_ctx`). */
  numCtx: number;
  /** Default max output tokens (Ollama `num_predict`). */
  maxOutputTokens: number;
  /** Default sampling temperature. */
  temperature: number;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** Single-user concurrency (Ollama `OLLAMA_NUM_PARALLEL`). */
  numParallel: number;
  /** Whether vision input is enabled. */
  visionEnabled: boolean;
  /** If false, never spawn `ollama serve` — assume an externally-managed daemon. */
  manageProcess: boolean;
}

/**
 * Normalized progress for a model pull (`/api/pull`), emitted by the sidecar to
 * higher layers as it downloads. `completed`/`total` are bytes for the layer
 * currently transferring; `percent` is derived [0..100] when both are known.
 */
export interface PullProgress {
  /** Ollama status line: 'pulling manifest' | 'downloading' | 'verifying' | 'success' | … */
  status: string;
  completed?: number;
  total?: number;
  percent?: number;
  /**
   * The model tag this line belongs to. Provisioning walks the required set in
   * sequence, so `percent` is per-model; the UI names this one and aggregates
   * across the set rather than letting the bar reset between models (ADR-0009).
   */
  model?: string;
}

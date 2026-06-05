/**
 * Orchestrator types. The orchestrator assembles a turn, lets the local model
 * call server-side tools, dispatches them deterministically, and (for emitted
 * HTML) runs the unconditional allowlist + accessibility gate (PRD §13/§15).
 */
import type { ChatChunk, ChatMessage, ChatOptions, ChatResult, ModelRole, ToolCall, ToolDefinition } from '../llm/index.js';
import type { ProductMode } from '../contracts/index.js';

/**
 * A streamed turn event surfaced to the caller via `ToolContext.onEvent`:
 * incremental assistant text, or the name of a tool as it begins executing.
 * (The runtime bridges these to the contract's `TurnChunk` over IPC.)
 */
export type OrchestratorEvent = { type: 'text'; delta: string } | { type: 'tool'; name: string };

/** Per-call context threaded to tools (session, abort, etc. — extend as needed). */
export interface ToolContext {
  signal?: AbortSignal;
  /** Active product mode for this turn (informational; filtering happens in handleTurn). */
  mode?: ProductMode;
  /** Optional sink for streamed text/tool events during the turn. */
  onEvent?: (e: OrchestratorEvent) => void;
}

/** A server-side tool the model may invoke. */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** The LLM capability the orchestrator needs — satisfied by the OllamaSidecar. */
export interface ChatRunner {
  chat(opts: ChatOptions): Promise<ChatResult>;
  /**
   * Optional streaming chat — yields text deltas as they arrive. When present
   * (and a turn requests events) `handleTurn` streams instead of `chat`.
   * OPTIONAL so existing fakes that only implement `chat` still satisfy the type.
   */
  chatStream?(opts: ChatOptions): AsyncGenerator<ChatChunk>;
}

export interface TurnInput {
  /** System prompt (voice + hard rules + active Knowledge Pack context). */
  system?: string;
  /** The user's message. */
  user: string;
  /** Model role for this turn (defaults to `text`). */
  role?: ModelRole;
  /** Prior transcript to continue. */
  history?: ChatMessage[];
  /**
   * Active product mode. When set, `handleTurn` filters advertised tools to the
   * mode's allowed set and scopes KB retrieval to the mode's packs. When unset,
   * behaviour is identical to before modes existed (no filtering, all packs).
   */
  mode?: ProductMode;
}

export interface ToolInvocation {
  call: ToolCall;
  result?: unknown;
  error?: string;
}

export interface TurnResult {
  /** Final assistant text. */
  text: string;
  /** How many model round-trips it took. */
  iterations: number;
  /** Every tool the model called, with results/errors. */
  toolInvocations: ToolInvocation[];
  /** Full transcript including tool turns (resumable). */
  messages: ChatMessage[];
}

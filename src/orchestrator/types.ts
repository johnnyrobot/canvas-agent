/**
 * Orchestrator types. The orchestrator assembles a turn, lets the local model
 * call server-side tools, dispatches them deterministically, and (for emitted
 * HTML) runs the unconditional allowlist + accessibility gate (PRD §13/§15).
 */
import type { ChatMessage, ChatOptions, ChatResult, ModelRole, ToolCall, ToolDefinition } from '../llm/index.js';

/** Per-call context threaded to tools (session, abort, etc. — extend as needed). */
export interface ToolContext {
  signal?: AbortSignal;
}

/** A server-side tool the model may invoke. */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** The LLM capability the orchestrator needs — satisfied by the OllamaSidecar. */
export interface ChatRunner {
  chat(opts: ChatOptions): Promise<ChatResult>;
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

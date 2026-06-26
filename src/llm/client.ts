/**
 * HTTP client for the local Ollama server (native `/api/chat`).
 *
 * Dependency-free: uses the global `fetch` (Node 20+). This is a "dumb transport"
 * — it does no accessibility gating or allowlist enforcement; those are
 * deterministic, server-side stages elsewhere in the pipeline (PRD §13.3/§15.7).
 */
import type { ChatChunk, ChatOptions, ChatResult, LLMConfig } from './types.js';
import { buildChatRequest } from './payload.js';
import { parseNdjson } from './ndjson.js';

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

interface NativeChatStreamChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[];
  };
  done?: boolean;
  /** Why generation stopped, on the terminal chunk: 'stop' | 'length' | … */
  done_reason?: string;
  /** Ollama emits a standalone `{"error":…}` line if generation fails mid-stream. */
  error?: string;
}

interface NativeChatResponse {
  model: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[];
  };
  done?: boolean;
  /** Why generation stopped: 'stop' | 'length' (truncation) | … */
  done_reason?: string;
  /** A 200 response can still carry a body-level error if generation failed. */
  error?: string;
}

/** One NDJSON progress line from `/api/pull` (the fields we consume). */
interface NativePullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  /** Ollama emits a standalone `{"error":…}` line if the pull fails. */
  error?: string;
}

/** Combine an optional caller signal with a per-request timeout. */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type FetchLike = typeof fetch;

export class OllamaClient {
  constructor(
    private readonly config: LLMConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Non-streaming chat completion. */
  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body = buildChatRequest(opts, this.config, false);
    const res = await this.post('/api/chat', body, opts.signal);
    const data = (await res.json()) as NativeChatResponse;
    // A body-level error on a 200 response means generation failed — reject rather
    // than surface a silent empty completion (parity with chatStream; C11).
    if (typeof data.error === 'string' && data.error !== '') {
      throw new OllamaError(`Ollama chat error: ${data.error}`);
    }
    const result: ChatResult = {
      content: data.message?.content ?? '',
      model: data.model,
      raw: data,
    };
    // Surface `done_reason` so a truncated ('length') completion is detectable
    // downstream (e.g. the ChangeLog). Set only when non-empty (exactOptionalPropertyTypes).
    if (typeof data.done_reason === 'string' && data.done_reason !== '') {
      result.doneReason = data.done_reason;
    }
    if (data.message?.thinking) result.thinking = data.message.thinking;
    const toolCalls = (data.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c) => ({ name: c.function!.name!, arguments: c.function!.arguments ?? {} }));
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    return result;
  }

  /** Streaming chat completion — yields text deltas (and any tool calls) as they arrive. */
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
    const body = buildChatRequest(opts, this.config, true);
    const res = await this.post('/api/chat', body, opts.signal);
    for await (const obj of parseNdjson<NativeChatStreamChunk>(res.body)) {
      // A mid-stream failure arrives as a standalone `{"error":…}` line; surface it
      // as a thrown rejection instead of silently ending the stream (which would
      // make a half-generated draft look complete) — C11.
      if (typeof obj.error === 'string' && obj.error !== '') {
        throw new OllamaError(`Ollama stream error: ${obj.error}`);
      }
      const delta = obj.message?.content ?? '';
      const done = obj.done === true;
      const toolCalls = (obj.message?.tool_calls ?? [])
        .filter((c) => c.function?.name)
        .map((c) => ({ name: c.function!.name!, arguments: c.function!.arguments ?? {} }));
      if (delta || done || toolCalls.length > 0) {
        const chunk: ChatChunk = { delta, done };
        if (toolCalls.length > 0) chunk.toolCalls = toolCalls;
        // Carry `done_reason` on the terminal chunk so a truncation ('length') is
        // detectable downstream. Only set when non-empty (exactOptionalPropertyTypes).
        if (done && typeof obj.done_reason === 'string' && obj.done_reason !== '') {
          chunk.doneReason = obj.done_reason;
        }
        yield chunk;
      }
      if (done) return;
    }
  }

  /**
   * Pull a model into the local Ollama store, yielding native progress lines.
   *
   * Unlike chat, a pull is a multi-GB, many-minute download — so it deliberately
   * BYPASSES `post()`'s per-request `timeoutMs`; only the caller's `signal` can
   * cancel it. Streams Ollama's NDJSON progress (`{status,total,completed}`); a
   * standalone `{"error":…}` line (e.g. an unknown tag) is surfaced as a rejection.
   */
  async *pullModel(name: string, signal?: AbortSignal): AsyncGenerator<NativePullProgress> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.nativeUrl + '/api/pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
        signal: signal ?? null, // NO withTimeout — a model download legitimately runs for minutes
      });
    } catch (err) {
      throw new OllamaError(`Request to /api/pull failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaError(`Ollama /api/pull returned ${res.status}`, res.status, text);
    }
    for await (const obj of parseNdjson<NativePullProgress>(res.body)) {
      if (typeof obj.error === 'string' && obj.error !== '') {
        throw new OllamaError(`Ollama pull error: ${obj.error}`);
      }
      yield obj;
    }
  }

  /** Native POST helper with JSON body, timeout, and error surfacing. */
  async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.config.nativeUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: withTimeout(signal, this.config.timeoutMs),
      });
    } catch (err) {
      throw new OllamaError(`Request to ${path} failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaError(`Ollama ${path} returned ${res.status}`, res.status, text);
    }
    return res;
  }
}

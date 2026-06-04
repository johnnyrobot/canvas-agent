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
  message?: { content?: string; thinking?: string };
  done?: boolean;
}

interface NativeChatResponse {
  model: string;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[];
  };
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
    const result: ChatResult = {
      content: data.message?.content ?? '',
      model: data.model,
      raw: data,
    };
    if (data.message?.thinking) result.thinking = data.message.thinking;
    const toolCalls = (data.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c) => ({ name: c.function!.name!, arguments: c.function!.arguments ?? {} }));
    if (toolCalls.length > 0) result.toolCalls = toolCalls;
    return result;
  }

  /** Streaming chat completion — yields text deltas as they arrive. */
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
    const body = buildChatRequest(opts, this.config, true);
    const res = await this.post('/api/chat', body, opts.signal);
    for await (const obj of parseNdjson<NativeChatStreamChunk>(res.body)) {
      const delta = obj.message?.content ?? '';
      const done = obj.done === true;
      if (delta || done) yield { delta, done };
      if (done) return;
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

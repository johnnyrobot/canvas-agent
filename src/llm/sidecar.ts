/**
 * The local LLM sidecar facade: ties the `ollama serve` lifecycle to the chat
 * client, serializes requests for the single-user app, and exposes the
 * role-based API the orchestrator consumes (PRD §15).
 */
import type {
  ChatChunk,
  ChatOptions,
  ChatResult,
  DescribeImageOptions,
  LLMConfig,
} from './types.js';
import { loadLLMConfig, type Env } from './config.js';
import { OllamaClient, OllamaError, type FetchLike } from './client.js';
import { OllamaProcess, type OllamaProcessLogger } from './process.js';
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
  logger?: OllamaProcessLogger;
  /** Injectable transport for the chat client (tests pass a fake; default global `fetch`). */
  fetch?: FetchLike;
}

export class OllamaSidecar {
  readonly config: LLMConfig;
  private readonly client: OllamaClient;
  private readonly process: OllamaProcess;
  private readonly mutex = new Mutex();

  constructor(options: CreateSidecarOptions = {}) {
    this.config = loadLLMConfig(options.env);
    this.client = new OllamaClient(this.config, options.fetch);
    this.process = new OllamaProcess(this.config, options.logger);
  }

  /** Ensure the daemon is running and the model(s) are warm. Idempotent-ish. */
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

  /** Non-streaming chat, serialized against other heavy calls. */
  chat(opts: ChatOptions): Promise<ChatResult> {
    return this.mutex.run(() => this.client.chat(opts));
  }

  /** Streaming chat — holds the lock for the duration of the stream. */
  async *chatStream(opts: ChatOptions): AsyncGenerator<ChatChunk> {
    const release = await this.mutex.acquire();
    try {
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
  describeImage(opts: DescribeImageOptions): Promise<ChatResult> {
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
    return this.chat({
      role: opts.role ?? 'vision',
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
  }
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

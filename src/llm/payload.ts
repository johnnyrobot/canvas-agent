/**
 * Builds native Ollama `/api/chat` request bodies from role-based ChatOptions.
 *
 * We use the native endpoint (not `/v1/chat/completions`) internally because it
 * exposes `num_ctx`, `keep_alive`, structured `format`, `think`, and the `images`
 * array — controls the PRD needs (§15.1/§15.4) that the OpenAI-compat shim omits.
 * The same Ollama server still exposes the OpenAI-compatible endpoint for any
 * external tooling.
 *
 * Pure and dependency-free.
 */
import type {
  ChatMessage,
  ChatOptions,
  ContentPart,
  LLMConfig,
  ModelRole,
  ToolCall,
} from './types.js';

export interface NativeToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface NativeMessage {
  role: ChatMessage['role'];
  content: string;
  /** Raw base64 image data (no `data:` prefix). */
  images?: string[];
  tool_calls?: NativeToolCall[];
  tool_name?: string;
}

export interface NativeTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface NativeChatRequest {
  model: string;
  messages: NativeMessage[];
  stream: boolean;
  keep_alive: string;
  format?: 'json' | Record<string, unknown>;
  think?: boolean;
  tools?: NativeTool[];
  options: {
    temperature: number;
    num_ctx: number;
    num_predict: number;
  };
}

/** Resolve a role to a concrete model tag (defaults to the `text` role). */
export function resolveModel(role: ModelRole | undefined, config: LLMConfig): string {
  return config.models[role ?? 'text'] ?? config.models.text;
}

/** Strip an optional `data:<mime>;base64,` prefix, leaving raw base64. */
export function toRawBase64(url: string): string {
  const comma = url.indexOf(',');
  return url.startsWith('data:') && comma >= 0 ? url.slice(comma + 1) : url;
}

function mapToolCalls(calls: ToolCall[]): NativeToolCall[] {
  return calls.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
}

/** Flatten a (possibly multimodal) message into Ollama's `{content, images}` shape. */
export function toNativeMessage(message: ChatMessage): NativeMessage {
  const native: NativeMessage =
    typeof message.content === 'string'
      ? { role: message.role, content: message.content }
      : flattenContent(message.role, message.content);
  if (message.toolCalls && message.toolCalls.length > 0) native.tool_calls = mapToolCalls(message.toolCalls);
  if (message.toolName) native.tool_name = message.toolName;
  return native;
}

function flattenContent(role: ChatMessage['role'], parts: ContentPart[]): NativeMessage {
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') texts.push(part.text);
    else if (part.type === 'image_url') images.push(toRawBase64(part.image_url.url));
  }
  const native: NativeMessage = { role, content: texts.join('\n') };
  if (images.length > 0) native.images = images;
  return native;
}

export function toNativeTools(tools: ChatOptions['tools']): NativeTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function buildChatRequest(
  opts: ChatOptions,
  config: LLMConfig,
  stream: boolean,
): NativeChatRequest {
  const req: NativeChatRequest = {
    model: resolveModel(opts.role, config),
    messages: opts.messages.map(toNativeMessage),
    stream,
    keep_alive: config.keepAlive,
    options: {
      temperature: opts.temperature ?? config.temperature,
      num_ctx: opts.numCtx ?? config.numCtx,
      num_predict: opts.maxTokens ?? config.maxOutputTokens,
    },
  };
  if (opts.format !== undefined) req.format = opts.format;
  if (opts.think !== undefined) req.think = opts.think;
  const tools = toNativeTools(opts.tools);
  if (tools) req.tools = tools;
  return req;
}

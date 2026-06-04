/**
 * Local LLM inference sidecar — public surface.
 *
 * Single on-device model (Gemma 4 12B via Ollama MLX) for text + vision + audio;
 * no cloud, no external API (PRD §15.1, no-cloud constraint). Consumed by the
 * orchestrator (PRD §13/§15); the deterministic accessibility gate lives
 * elsewhere — this module is transport only.
 */
export { createOllamaSidecar, OllamaSidecar, OllamaJsonError, stripCodeFences } from './sidecar.js';
export { OllamaClient, OllamaError } from './client.js';
export { OllamaProcess } from './process.js';
export { loadLLMConfig, deriveNativeUrl, uniqueModels } from './config.js';
export { resolveModel, buildChatRequest, toNativeMessage, toRawBase64 } from './payload.js';
export { Mutex } from './mutex.js';
export type {
  ModelRole,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatChunk,
  ContentPart,
  DescribeImageOptions,
  ToolDefinition,
  ToolCall,
  LLMConfig,
} from './types.js';
export { MODEL_ROLES } from './types.js';

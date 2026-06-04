/**
 * Loads the local-LLM config from the environment (PRD Appendix H).
 * Pure and dependency-free so it is trivially unit-testable.
 */
import type { LLMConfig, ModelRole } from './types.js';

export type Env = Record<string, string | undefined>;

const DEFAULT_MODEL = 'gemma4:12b-mlx';

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for ${key}: ${JSON.stringify(v)}`);
  }
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** Derive the native Ollama root (no `/v1`) from the OpenAI-compatible base URL. */
export function deriveNativeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

export function loadLLMConfig(env: Env = process.env): LLMConfig {
  const baseUrl = str(env, 'LLM_BASE_URL', 'http://localhost:11434/v1');

  // Each role resolves to its own env var, falling back to MODEL_TEXT, then the
  // global default. In v1 they all point at the one Gemma 4 12B build.
  const text = str(env, 'MODEL_TEXT', DEFAULT_MODEL);
  const models: Record<ModelRole, string> = {
    text,
    vision: str(env, 'MODEL_VISION', text),
    fast: str(env, 'MODEL_FAST', text),
    deep: str(env, 'MODEL_DEEP', text),
    cheap: str(env, 'MODEL_CHEAP', text),
  };

  return {
    baseUrl,
    nativeUrl: deriveNativeUrl(baseUrl),
    ollamaHost: str(env, 'OLLAMA_HOST', '127.0.0.1:11434'),
    models,
    keepAlive: str(env, 'OLLAMA_KEEP_ALIVE', '24h'),
    numCtx: num(env, 'LLM_NUM_CTX', 32768),
    maxOutputTokens: num(env, 'LLM_MAX_OUTPUT_TOKENS', 8000),
    temperature: num(env, 'LLM_TEMPERATURE', 0.3),
    timeoutMs: num(env, 'LLM_TIMEOUT_MS', 120000),
    numParallel: num(env, 'OLLAMA_NUM_PARALLEL', 1),
    visionEnabled: bool(env, 'LLM_VISION_ENABLED', true),
    manageProcess: bool(env, 'LLM_MANAGE_PROCESS', true),
  };
}

/** Distinct model tags across all roles (for warm-loading). */
export function uniqueModels(config: LLMConfig): string[] {
  return [...new Set(Object.values(config.models))];
}

/**
 * Loads the local-LLM config from the environment (PRD Appendix H).
 * Pure and dependency-free so it is trivially unit-testable.
 */
import {
  REQUIRED_MODEL_ROLES,
  type LLMConfig,
  type ModelRole,
  type RequiredModelRole,
} from './types.js';

export type Env = Record<string, string | undefined>;

// This module deliberately holds NO shipping model default (ADR-0007). Model
// selection is the runtime's job, steered in through `MODEL_TEXT`; a fallback
// here would be a second default that silently diverges from the real one, and
// the tag it used to hold was licence-encumbered. Callers that construct a
// config directly must say which model they mean.

/** Read a required env var, or throw naming where the value should come from. */
function required(env: Env, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new Error(
      `${key} is required — shipping defaults live in the runtime (see runtimeLlmEnv in src/runtime/deps.ts, ADR-0007).`,
    );
  }
  return v;
}

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

  // Each role resolves to its own env var, falling back to MODEL_TEXT. There is
  // no module-level default below that: MODEL_TEXT is required (see `required`).
  const text = required(env, 'MODEL_TEXT');
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

/**
 * Whether each required role is required *of this configuration* (ADR-0010).
 *
 * The required set is derived, not fixed. A capability the operator switched off
 * leaves it: `describeImage` throws before touching a model when vision is
 * disabled, so provisioning it would download ~3.3 GB to gate readiness on
 * weights nothing will ever call.
 *
 * A predicate per role rather than a special case inside the caller, so a third
 * required role has one obvious place to say when it applies.
 */
const ROLE_APPLIES: Readonly<Record<RequiredModelRole, (config: LLMConfig) => boolean>> = {
  text: () => true,
  vision: (config) => config.visionEnabled,
};

/** Whether this configuration requires `role` at all (ADR-0010). */
export function roleIsRequired(config: LLMConfig, role: RequiredModelRole): boolean {
  return ROLE_APPLIES[role](config);
}

/**
 * The roles this configuration actually requires, paired with the tags they
 * resolve to (ADR-0009), in role order.
 *
 * Roles outside the required set never appear here, so `MODEL_DEEP=granite4.1:30b`
 * can neither be downloaded nor gate readiness for a role nothing calls — and
 * nor can a role whose capability is switched off (ADR-0010).
 *
 * This is the *requirement* question, and it is deliberately not the *reporting*
 * question: `modelStatus` reports one entry per required role whether or not this
 * configuration requires it, because a role that vanishes from the payload reads
 * to the UI as "nothing missing". Conflating the two is what made a disabled
 * capability cost a multi-gigabyte download.
 */
export function requiredModels(config: LLMConfig): Array<{ role: RequiredModelRole; tag: string }> {
  return REQUIRED_MODEL_ROLES.filter((role) => roleIsRequired(config, role)).map((role) => ({
    role,
    tag: config.models[role],
  }));
}

/**
 * The tags first-run provisioning must download: the required roles,
 * deduplicated and in role order.
 *
 * At the shipping defaults this is two tags and two downloads (#33). The
 * deduplication is for the configuration that still collapses them — both
 * required roles pointed at one multimodal tag, which is what any caller that
 * omits `MODEL_VISION` gets — where pulling the same gigabytes twice would be
 * absurd.
 */
export function requiredModelTags(config: LLMConfig): string[] {
  return [...new Set(requiredModels(config).map((m) => m.tag))];
}

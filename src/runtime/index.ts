/**
 * runtime — the integration keystone (Wave 3). Public surface.
 *
 * Wires the finished modules (engine, theme, templates, knowledge, canvas, the
 * LLM + Docling sidecars) into the orchestrator and exposes the FROZEN `AppApi`
 * from `src/contracts`. `createAppApi` is what the Electron app-shell consumes
 * over IPC; `createEngineDeps` adapts the real implementations onto the
 * orchestrator's `EngineDeps`.
 */
export { createAppApi, DEFAULT_SYSTEM_PROMPT } from './app-api.js';
export type { AppApiOptions, LlmRuntime, IngestRuntime } from './app-api.js';
export { createRuntime, DRAIN_TIMEOUT_MS } from './runtime.js';
export type { RuntimeHandle, CreateRuntimeOptions, OwnedLlm, OwnedIngest } from './runtime.js';
export { createActivityTracker, noopActivityTracker } from './activity.js';
export type { ActivityTracker } from './activity.js';
export { createLazyDatabase } from './database.js';
export type { LazyDatabase } from './database.js';
export {
  createEngineDeps,
  runtimeLlmEnv,
  SHIPPED_MODEL_LICENCES,
  PERMISSIVE_LICENCES,
  RUNTIME_DEFAULT_MODEL,
  RUNTIME_DEFAULT_VISION_MODEL,
} from './deps.js';
export type {
  EngineDepsOptions,
  LlmDescriber,
  DocConverter,
  RuntimeEnv,
} from './deps.js';

// Re-export the runtime boundary contract for consumers (app-shell) convenience.
export type {
  AppApi,
  TurnRequest,
  TurnView,
  TurnFragment,
  RuntimeHealth,
} from '../contracts/index.js';

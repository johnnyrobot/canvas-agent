/**
 * Shared sidecar process lifecycle (ADR-0004).
 *
 * A LEAF module: `src/llm` and `src/ingest` import from here; nothing here
 * imports from them, or from `src/runtime` (the composition root).
 */
export {
  SidecarLifecycle,
  type RespawnPolicy,
  type SidecarLifecycleOptions,
  type SidecarLogger,
  type SpawnLike,
  type SpawnSpec,
} from './lifecycle.js';

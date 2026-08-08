/**
 * Construct the production runtime handle, falling back to an HONEST degraded
 * API when the real local runtime can't be built (sidecars missing, DB
 * unopenable, …).
 *
 * Extracted from `main.ts` (which imports Electron and so can't run under
 * `node:test`) precisely so this fallback POLICY is unit-tested: the fallback is
 * `createUnavailableApi`, NOT the demo `createStubApi` — a dead runtime must
 * never report healthy or fabricate a passing accessibility badge (C3).
 *
 * It carries a `RuntimeHandle` rather than a bare `AppApi` so `main.ts` can
 * reach the sidecars on quit (ADR-0006, #13). The degraded path gets a no-op
 * `dispose`: there is nothing running to stop, and a runtime that failed to
 * build must still quit cleanly.
 */
import type { RuntimeHandle } from '../runtime/index.js';
import { createUnavailableApi } from './unavailable-api.js';

export function buildApi(createReal: () => RuntimeHandle): RuntimeHandle {
  try {
    return createReal();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      '[canvas-agent] real runtime unavailable; serving a degraded (non-fabricating) API:',
      reason,
    );
    return { api: createUnavailableApi(reason), dispose: async () => {} };
  }
}

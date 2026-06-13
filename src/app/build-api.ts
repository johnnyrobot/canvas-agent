/**
 * Construct the production `AppApi`, falling back to an HONEST degraded API when
 * the real local runtime can't be built (sidecars missing, DB unopenable, …).
 *
 * Extracted from `main.ts` (which imports Electron and so can't run under
 * `node:test`) precisely so this fallback POLICY is unit-tested: the fallback is
 * `createUnavailableApi`, NOT the demo `createStubApi` — a dead runtime must
 * never report healthy or fabricate a passing accessibility badge (C3).
 */
import type { AppApi } from '../contracts/index.js';
import { createUnavailableApi } from './unavailable-api.js';

export function buildApi(createReal: () => AppApi): AppApi {
  try {
    return createReal();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      '[canvas-agent] real runtime unavailable; serving a degraded (non-fabricating) API:',
      reason,
    );
    return createUnavailableApi(reason);
  }
}

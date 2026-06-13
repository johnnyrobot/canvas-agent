/**
 * `createUnavailableApi(reason): AppApi` — the HONEST fallback used when the real
 * local runtime (`createAppApi`) cannot be constructed (sidecars missing, the
 * on-device DB unopenable, …).
 *
 * Unlike the demo `createStubApi`, it NEVER fabricates a passing accessibility
 * badge and NEVER reports the runtime as healthy: `health()` is all-false and
 * every method that would require a working runtime rejects with a clear error.
 * This prevents a dead runtime from silently certifying content as "accessible"
 * — exactly the overlay failure mode the product's unconditional gate exists to
 * avoid. The two pure list reads return empty (no data ≠ fabricated data) so the
 * shell still renders a usable, honestly-empty degraded state.
 */
import type { AppApi, BrandKit, RuntimeHealth, Session } from '../contracts/index.js';

export class RuntimeUnavailableError extends Error {
  constructor(reason: string) {
    super(`Canvas Agent runtime is unavailable: ${reason}`);
    this.name = 'RuntimeUnavailableError';
  }
}

export function createUnavailableApi(reason: string): AppApi {
  const fail = (): never => {
    throw new RuntimeUnavailableError(reason);
  };
  return {
    async health(): Promise<RuntimeHealth> {
      return { llm: false, ingest: false };
    },
    async runTurn() {
      return fail();
    },
    async importCanvas() {
      return fail();
    },
    async createSession() {
      return fail();
    },
    async listSessions(): Promise<Session[]> {
      return [];
    },
    async loadSession() {
      return fail();
    },
    async deleteSession() {
      return fail();
    },
    async resolveBrandTheme() {
      return fail();
    },
    async listBrandKits(): Promise<BrandKit[]> {
      return [];
    },
    async saveBrandKit() {
      return fail();
    },
    async deleteBrandKit() {
      return fail();
    },
    async fetchCanvasPage() {
      return fail();
    },
    async listCanvasPages() {
      return fail();
    },
  };
}

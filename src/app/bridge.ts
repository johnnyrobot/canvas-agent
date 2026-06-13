/**
 * The renderer-facing bridge object — PURE and testable.
 *
 * `preload.ts` calls `createBridge(invoke, subscribe)` and hands the result to
 * `contextBridge.exposeInMainWorld`, so the renderer sees a typed
 * `window.canvasAgent: AppApi`. Keeping the unwrapping logic here (rather than
 * inline in `preload.ts`) means it can be unit-tested without importing
 * `electron`.
 *
 * Each method invokes the matching channel and unwraps the `IpcResult` envelope:
 * a success returns the value; a failure re-throws a real `Error` so the
 * renderer can `try/catch` it like any other rejected promise.
 *
 * Streaming: `runTurn(req, onChunk?)` tunnels the in-process `OnTurnChunk`
 * callback across the contextBridge. When a callback is given it mints a
 * `turnId`, subscribes to the one-way `CHUNK` event, filters to chunks tagged
 * with that id, and forwards them to `onChunk`; the subscription is always torn
 * down once the turn's reply resolves (or rejects).
 */
import type { AppApi, TurnChunk } from '../contracts/index.js';
import type { IpcResult } from './ipc.js';
import {
  RUN_TURN,
  SAVE_CANVAS_AUTH,
  IMPORT_CANVAS,
  HEALTH,
  CREATE_SESSION,
  LIST_SESSIONS,
  LOAD_SESSION,
  DELETE_SESSION,
  RESOLVE_BRAND_THEME,
  LIST_BRAND_KITS,
  SAVE_BRAND_KIT,
  DELETE_BRAND_KIT,
  FETCH_CANVAS_PAGE,
  LIST_CANVAS_PAGES,
  CHUNK,
} from './channels.js';

/** Mirrors `ipcRenderer.invoke`: send on a channel, await the main-process reply. */
export type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/**
 * Mirrors a one-way `ipcRenderer.on` subscription: register `handler` for the
 * channel's event payloads and return a function that removes the listener.
 */
export type Subscribe = (channel: string, handler: (payload: unknown) => void) => () => void;

function unwrap<T>(result: unknown): T {
  const res = result as IpcResult<T>;
  if (res.ok) return res.value;
  const err = new Error(res.error.message);
  err.name = res.error.name;
  throw err;
}

/** Build the `window.canvasAgent` object that mirrors `AppApi` over IPC. */
export function createBridge(invoke: Invoke, subscribe: Subscribe): AppApi {
  return {
    async runTurn(req, onChunk) {
      // No callback ⇒ a plain request/response turn, no streaming subscription.
      if (!onChunk) {
        return unwrap(await invoke(RUN_TURN, { req }));
      }
      // Streaming: mint a turnId, subscribe to CHUNK, route matching chunks to
      // `onChunk`, and always unsubscribe once the reply settles.
      const turnId = crypto.randomUUID();
      const off = subscribe(CHUNK, (payload) => {
        const p = payload as { turnId: string; chunk: TurnChunk };
        if (p.turnId === turnId) onChunk(p.chunk);
      });
      try {
        return unwrap(await invoke(RUN_TURN, { req, turnId }));
      } finally {
        off();
      }
    },
    async saveCanvasAuth(auth) {
      return unwrap(await invoke(SAVE_CANVAS_AUTH, auth));
    },
    async importCanvas(baseUrl, courseId) {
      return unwrap(await invoke(IMPORT_CANVAS, baseUrl, courseId));
    },
    async health() {
      return unwrap(await invoke(HEALTH));
    },

    // ── Sessions ───────────────────────────────────────────────────────────────
    async createSession(init) {
      return unwrap(await invoke(CREATE_SESSION, init));
    },
    async listSessions() {
      return unwrap(await invoke(LIST_SESSIONS));
    },
    async loadSession(sessionId) {
      return unwrap(await invoke(LOAD_SESSION, sessionId));
    },
    async deleteSession(sessionId) {
      return unwrap(await invoke(DELETE_SESSION, sessionId));
    },

    // ── Brand kits ───────────────────────────────────────────────────────────────
    async resolveBrandTheme(primary, secondary) {
      return unwrap(await invoke(RESOLVE_BRAND_THEME, primary, secondary));
    },
    async listBrandKits() {
      return unwrap(await invoke(LIST_BRAND_KITS));
    },
    async saveBrandKit(kit) {
      return unwrap(await invoke(SAVE_BRAND_KIT, kit));
    },
    async deleteBrandKit(id) {
      return unwrap(await invoke(DELETE_BRAND_KIT, id));
    },

    // ── Read-only Canvas page access (token-free; baseUrl only) ──────────────────
    async fetchCanvasPage(baseUrl, courseId, pageId) {
      return unwrap(await invoke(FETCH_CANVAS_PAGE, baseUrl, courseId, pageId));
    },
    async listCanvasPages(baseUrl, courseId) {
      return unwrap(await invoke(LIST_CANVAS_PAGES, baseUrl, courseId));
    },
  };
}

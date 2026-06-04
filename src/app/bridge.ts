/**
 * The renderer-facing bridge object — PURE and testable.
 *
 * `preload.ts` calls `createBridge(ipcRenderer.invoke)` and hands the result to
 * `contextBridge.exposeInMainWorld`, so the renderer sees a typed
 * `window.canvasAgent: AppApi`. Keeping the unwrapping logic here (rather than
 * inline in `preload.ts`) means it can be unit-tested without importing
 * `electron`.
 *
 * Each method invokes the matching channel and unwraps the `IpcResult` envelope:
 * a success returns the value; a failure re-throws a real `Error` so the
 * renderer can `try/catch` it like any other rejected promise.
 */
import type { AppApi } from '../contracts/index.js';
import type { IpcResult } from './ipc.js';
import { RUN_TURN, IMPORT_CANVAS, HEALTH } from './channels.js';

/** Mirrors `ipcRenderer.invoke`: send on a channel, await the main-process reply. */
export type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

function unwrap<T>(result: unknown): T {
  const res = result as IpcResult<T>;
  if (res.ok) return res.value;
  const err = new Error(res.error.message);
  err.name = res.error.name;
  throw err;
}

/** Build the `window.canvasAgent` object that mirrors `AppApi` over IPC. */
export function createBridge(invoke: Invoke): AppApi {
  return {
    async runTurn(req) {
      return unwrap(await invoke(RUN_TURN, req));
    },
    async importCanvas(config, courseId) {
      return unwrap(await invoke(IMPORT_CANVAS, config, courseId));
    },
    async health() {
      return unwrap(await invoke(HEALTH));
    },
  };
}

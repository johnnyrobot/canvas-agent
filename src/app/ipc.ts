/**
 * PURE IPC wiring — the testable core of the Electron main process.
 *
 * `registerIpc` binds each channel (`channels.ts`) to the matching `AppApi`
 * method. It never imports `electron`: it takes an `IpcMainLike` seam so it can
 * be unit-tested with a fake `ipcMain` + a fake `AppApi`. `main.ts` passes the
 * real `ipcMain`.
 *
 * Every handler returns a discriminated `IpcResult` envelope rather than letting
 * an error escape. The matching `bridge.ts` unwraps it on the renderer side, so
 * a runtime failure surfaces as a rejected promise in the UI — never a silent
 * `undefined` or an unhandled `ipcRenderer.invoke` rejection.
 */
import type { AppApi, CanvasConfig, TurnRequest } from '../contracts/index.js';
import { RUN_TURN, IMPORT_CANVAS, HEALTH } from './channels.js';

/** Serialisable error shape carried back over IPC (Error instances don't survive structured clone cleanly). */
export interface IpcError {
  name: string;
  message: string;
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcError };

/**
 * The slice of Electron's `ipcMain` we depend on. Electron's real `ipcMain` is
 * structurally assignable to this, so `main.ts` can pass it directly while tests
 * pass a recording fake.
 */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void;
}

function toIpcError(err: unknown): IpcError {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Error', message: String(err) };
}

/** Run `fn`, returning a success envelope or, on any throw/rejection, an error envelope. */
async function envelope<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: toIpcError(err) };
  }
}

/**
 * Register one IPC handler per `AppApi` method. PURE: no Electron import, no
 * global state — everything it needs is injected.
 */
export function registerIpc(ipcMain: IpcMainLike, api: AppApi): void {
  ipcMain.handle(RUN_TURN, (_event, req) =>
    envelope(() => api.runTurn(req as TurnRequest)),
  );

  ipcMain.handle(IMPORT_CANVAS, (_event, config, courseId) =>
    envelope(() => api.importCanvas(config as CanvasConfig, courseId as string)),
  );

  ipcMain.handle(HEALTH, () => envelope(() => api.health()));
}

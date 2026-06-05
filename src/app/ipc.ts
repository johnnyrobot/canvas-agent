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
 *
 * Streaming: `runTurn` may carry a `turnId`. When present, the handler forwards
 * each `TurnChunk` back to the requesting renderer over the one-way `CHUNK`
 * event (`event.sender.send`), tagged with that `turnId` so `bridge.ts` can
 * route it to the right `onChunk` callback. The final `TurnView` still comes
 * back through the normal `IpcResult` reply.
 */
import type {
  AppApi,
  BrandKit,
  CanvasConfig,
  ProductMode,
  TurnRequest,
} from '../contracts/index.js';
import {
  RUN_TURN,
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

/**
 * The slice of an Electron IPC event we depend on for streaming: the ability to
 * `send` a one-way event back to the requesting renderer. Electron's real
 * `IpcMainInvokeEvent` is structurally assignable to this; tests pass a fake
 * event that records the sends.
 */
export interface IpcEventLike {
  sender: { send(channel: string, payload: unknown): void };
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
  // Streaming turn: payload is `{ req, turnId? }`. With a `turnId`, stream each
  // chunk back over the CHUNK event tagged with that id; always reply with the
  // final TurnView through the envelope.
  ipcMain.handle(RUN_TURN, (event, payload) => {
    const { req, turnId } = (payload ?? {}) as { req: TurnRequest; turnId?: string };
    return envelope(() => {
      if (turnId === undefined) return api.runTurn(req);
      const sender = (event as IpcEventLike).sender;
      return api.runTurn(req, (chunk) => sender.send(CHUNK, { turnId, chunk }));
    });
  });

  ipcMain.handle(IMPORT_CANVAS, (_event, config, courseId) =>
    envelope(() => api.importCanvas(config as CanvasConfig, courseId as string)),
  );

  ipcMain.handle(HEALTH, () => envelope(() => api.health()));

  // ── Sessions ───────────────────────────────────────────────────────────────
  ipcMain.handle(CREATE_SESSION, (_event, init) =>
    envelope(() => api.createSession(init as { title: string; mode: ProductMode })),
  );

  ipcMain.handle(LIST_SESSIONS, () => envelope(() => api.listSessions()));

  ipcMain.handle(LOAD_SESSION, (_event, sessionId) =>
    envelope(() => api.loadSession(sessionId as string)),
  );

  ipcMain.handle(DELETE_SESSION, (_event, sessionId) =>
    envelope(() => api.deleteSession(sessionId as string)),
  );

  // ── Brand kits ───────────────────────────────────────────────────────────────
  ipcMain.handle(RESOLVE_BRAND_THEME, (_event, primary, secondary) =>
    envelope(() => api.resolveBrandTheme(primary as string, secondary as string)),
  );

  ipcMain.handle(LIST_BRAND_KITS, () => envelope(() => api.listBrandKits()));

  ipcMain.handle(SAVE_BRAND_KIT, (_event, kit) =>
    envelope(() => api.saveBrandKit(kit as Omit<BrandKit, 'id' | 'createdAt'>)),
  );

  ipcMain.handle(DELETE_BRAND_KIT, (_event, id) =>
    envelope(() => api.deleteBrandKit(id as string)),
  );

  // ── Read-only Canvas page access ─────────────────────────────────────────────
  ipcMain.handle(FETCH_CANVAS_PAGE, (_event, config, courseId, pageId) =>
    envelope(() =>
      api.fetchCanvasPage(config as CanvasConfig, courseId as string, pageId as string),
    ),
  );

  ipcMain.handle(LIST_CANVAS_PAGES, (_event, config, courseId) =>
    envelope(() => api.listCanvasPages(config as CanvasConfig, courseId as string)),
  );
}

/**
 * PURE IPC wiring — the testable core of the Electron main process.
 *
 * `registerIpc` binds each channel (`channels.ts`) to the matching `AppApi`
 * method. It never imports `electron`: it takes an `IpcMainLike` seam so it can
 * be unit-tested with a fake `ipcMain` + a fake `AppApi`. `main.ts` passes the
 * real `ipcMain`.
 *
 * Coverage is by construction, not by convention: the three streaming channels
 * are hand-written (they do work a table cannot express), and every other
 * handler is DERIVED by looping `CHANNELS`, which is itself compiler-checked
 * for completeness against `AppApi`. `registerIpc` takes `AppApi` as a
 * parameter, which constrains its callers rather than its body — the derivation
 * is what makes the body exhaustive.
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
import type { AppApi, TurnRequest } from '../contracts/index.js';
import {
  CHANNELS,
  RUN_TURN,
  PULL_MODEL,
  PULL_PROGRESS,
  PULL_INGEST_MODEL,
  INGEST_PULL_PROGRESS,
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
  // Registering through this wrapper (rather than `ipcMain.handle` directly)
  // records what has been handled, so the derived loop at the bottom can skip
  // the hand-written streaming channels without a second list to keep in sync.
  const handled = new Set<string>();
  const handle: IpcMainLike['handle'] = (channel, listener) => {
    handled.add(channel);
    ipcMain.handle(channel, listener);
  };

  // Streaming turn: payload is `{ req, turnId? }`. With a `turnId`, stream each
  // chunk back over the CHUNK event tagged with that id; always reply with the
  // final TurnView through the envelope.
  handle(RUN_TURN, (event, payload) => {
    const { req, turnId } = (payload ?? {}) as { req: TurnRequest; turnId?: string };
    return envelope(() => {
      if (turnId === undefined) return api.runTurn(req);
      const sender = (event as IpcEventLike).sender;
      return api.runTurn(req, (chunk) => sender.send(CHUNK, { turnId, chunk }));
    });
  });

  // First-run model download: payload is `{ pullId? }`. With a `pullId`, stream
  // each progress update back over the PULL_PROGRESS event tagged with that id;
  // the final reply (void on success, error envelope on failure) returns normally.
  handle(PULL_MODEL, (event, payload) => {
    const { pullId } = (payload ?? {}) as { pullId?: string };
    return envelope(() => {
      if (pullId === undefined) return api.pullModel();
      const sender = (event as IpcEventLike).sender;
      return api.pullModel((progress) => sender.send(PULL_PROGRESS, { pullId, progress }));
    });
  });

  // First-run Docling model download — same streaming shape as PULL_MODEL,
  // tagged over the INGEST_PULL_PROGRESS event channel.
  handle(PULL_INGEST_MODEL, (event, payload) => {
    const { pullId } = (payload ?? {}) as { pullId?: string };
    return envelope(() => {
      if (pullId === undefined) return api.pullIngestModel();
      const sender = (event as IpcEventLike).sender;
      return api.pullIngestModel((progress) => sender.send(INGEST_PULL_PROGRESS, { pullId, progress }));
    });
  });

  // ── Everything else, derived from the channel table ────────────────────────
  // The remaining twenty channels are uniformly
  // `(…args) => envelope(() => api.method(...args))`, so they are derived by
  // looping `CHANNELS` rather than hand-written. `CHANNELS` carries a
  // `satisfies Record<keyof AppApi, string>` constraint (see `channels.ts`),
  // so a new `AppApi` method cannot reach this loop without a channel — which
  // is what makes the registration exhaustive by construction. The three
  // streaming channels above are skipped because they are already registered.
  for (const [method, channel] of Object.entries(CHANNELS) as [keyof AppApi, string][]) {
    if (handled.has(channel)) continue;
    // TypeScript cannot correlate `method` to `Parameters<AppApi[typeof method]>`
    // across a runtime-computed key, so the call is erased to `unknown[]` here.
    // The arguments were already `unknown` at the `IpcMainLike.handle` seam, so
    // this widens nothing that was narrow — but it does mean a change to a
    // method's parameter list gets no compiler feedback in this file.
    const apiMethod = api[method] as (...args: unknown[]) => Promise<unknown>;
    handle(channel, (_event, ...args) => envelope(() => apiMethod.apply(api, args)));
  }
}

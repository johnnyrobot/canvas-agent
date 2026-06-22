/**
 * app-shell track — public surface.
 *
 * The Electron desktop shell that wraps the local runtime (`AppApi`) in a
 * window. This index re-exports ONLY the Electron-free, unit-tested pieces so it
 * can be imported from `node:test` (and the integration track) without pulling
 * in `electron` or the DOM. The Electron entry points (`main.ts`, `preload.ts`,
 * `renderer/`) are intentionally NOT exported here — they are loaded by Electron
 * directly, never imported by other modules.
 *
 * Contract ports implemented by this track:
 *   • `createStubApi(): AppApi` — a standalone, canned runtime so the app runs
 *     before the integration track lands; the lead swaps it for `createAppApi`.
 *   • `registerIpc(ipcMain, api)` — the typed IPC boundary onto `AppApi`.
 */
export {
  CHANNELS,
  RUN_TURN,
  IMPORT_CANVAS,
  HEALTH,
  CONVERT_DOCUMENT,
  SCREENSHOT_PERMISSION_STATUS,
  LIST_SCREENSHOT_SOURCES,
  CAPTURE_SCREENSHOT,
} from './channels.js';
export type { ChannelName } from './channels.js';

export { registerIpc } from './ipc.js';
export type { IpcMainLike, IpcResult, IpcError } from './ipc.js';

export { createBridge } from './bridge.js';
export type { Invoke } from './bridge.js';

export { createStubApi } from './stub-api.js';

export { turnViewToVm } from './view.js';
export type { TurnVm, FragmentVm, BadgeVm, BadgeKind } from './view.js';

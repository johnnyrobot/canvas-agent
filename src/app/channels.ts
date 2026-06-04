/**
 * IPC channel names shared by the Electron main process (`registerIpc`), the
 * preload bridge, and the renderer. Defined once here so a typo can't silently
 * desync the two sides of the `contextBridge`.
 *
 * Each name mirrors one method of the `AppApi` runtime boundary
 * (`src/contracts`). They are namespaced to avoid colliding with any other
 * `ipcMain.handle` channel.
 */

export const RUN_TURN = 'canvasAgent:runTurn';
export const IMPORT_CANVAS = 'canvasAgent:importCanvas';
export const HEALTH = 'canvasAgent:health';

/** All IPC channels, keyed by the `AppApi` method they back. */
export const CHANNELS = {
  runTurn: RUN_TURN,
  importCanvas: IMPORT_CANVAS,
  health: HEALTH,
} as const;

/** Union of every channel name (handy for typing a generic invoke). */
export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

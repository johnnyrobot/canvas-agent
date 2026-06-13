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
export const SAVE_CANVAS_AUTH = 'canvasAgent:saveCanvasAuth';
export const IMPORT_CANVAS = 'canvasAgent:importCanvas';
export const HEALTH = 'canvasAgent:health';

// ── Sessions ─────────────────────────────────────────────────────────────────
export const CREATE_SESSION = 'canvasAgent:createSession';
export const LIST_SESSIONS = 'canvasAgent:listSessions';
export const LOAD_SESSION = 'canvasAgent:loadSession';
export const DELETE_SESSION = 'canvasAgent:deleteSession';

// ── Brand kits ───────────────────────────────────────────────────────────────
export const RESOLVE_BRAND_THEME = 'canvasAgent:resolveBrandTheme';
export const LIST_BRAND_KITS = 'canvasAgent:listBrandKits';
export const SAVE_BRAND_KIT = 'canvasAgent:saveBrandKit';
export const DELETE_BRAND_KIT = 'canvasAgent:deleteBrandKit';

// ── Read-only Canvas page access ─────────────────────────────────────────────
export const FETCH_CANVAS_PAGE = 'canvasAgent:fetchCanvasPage';
export const LIST_CANVAS_PAGES = 'canvasAgent:listCanvasPages';

/**
 * One-way event channel carrying streamed `runTurn` chunks from main → renderer.
 * Deliberately NOT part of `CHANNELS`: it is a `send` (event), never a `handle`
 * (request/response), so it has no IPC handler to register.
 */
export const CHUNK = 'canvasAgent:chunk';

/** All request/response IPC channels, keyed by the `AppApi` method they back. */
export const CHANNELS = {
  runTurn: RUN_TURN,
  saveCanvasAuth: SAVE_CANVAS_AUTH,
  importCanvas: IMPORT_CANVAS,
  health: HEALTH,
  createSession: CREATE_SESSION,
  listSessions: LIST_SESSIONS,
  loadSession: LOAD_SESSION,
  deleteSession: DELETE_SESSION,
  resolveBrandTheme: RESOLVE_BRAND_THEME,
  listBrandKits: LIST_BRAND_KITS,
  saveBrandKit: SAVE_BRAND_KIT,
  deleteBrandKit: DELETE_BRAND_KIT,
  fetchCanvasPage: FETCH_CANVAS_PAGE,
  listCanvasPages: LIST_CANVAS_PAGES,
} as const;

/** Union of every channel name (handy for typing a generic invoke). */
export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

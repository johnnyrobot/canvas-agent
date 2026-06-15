/**
 * Electron main process — the only place that boots a `BrowserWindow`.
 *
 * Kept deliberately thin: all testable logic lives in `ipc.ts` / `stub-api.ts`.
 * This file just creates the window with secure defaults and wires the IPC
 * surface to an `AppApi`. The single integration seam is the argument to
 * `registerIpc`: today it's `createStubApi()`; post-merge the lead swaps in the
 * integration track's `createAppApi()` and nothing else here changes.
 *
 * Not unit-tested (Electron can't launch headless under `node:test`); exercised
 * via the manual `npm run app` smoke the lead adds after merge.
 */
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerIpc } from './ipc.js';
import { buildApi } from './build-api.js';
import { isInAppUrl, externalOpenTarget } from './navigation.js';
import { createAppApi } from '../runtime/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, 'renderer', 'index.html');
const appUrl = pathToFileURL(indexPath).toString();

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 840,
    title: 'Canvas Course Design & Accessibility Assistant',
    webPreferences: {
      // Secure renderer defaults: the renderer reaches main ONLY through the
      // typed `contextBridge` preload — no Node in the renderer.
      preload: path.join(here, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // `sandbox: false` is REQUIRED here: this is an ESM codebase ("type":
      // "module"), and Electron only supports ESM preload scripts when the
      // sandbox is disabled (sandboxed preloads must be CommonJS). With a
      // sandboxed ESM preload the bridge silently fails to load and
      // `window.canvasAgent` is undefined. Isolation is still enforced by
      // contextIsolation + nodeIntegration:false + the strict CSP, so the
      // renderer has no Node access and only ever sees the typed bridge — and
      // it only renders gate-approved HTML and loads no remote content.
      sandbox: false,
    },
  });

  // Navigation/window-open policy is applied GLOBALLY via the
  // `web-contents-created` guard below, so every webContents (this window and any
  // future one — e.g. a webview) inherits the same C8 lock-down. Nothing
  // window-specific is needed here.
  void win.loadFile(indexPath);
}

/**
 * Apply the C8 navigation lock-down to EVERY web-contents the app ever creates,
 * not just the first window: a link in gated content can never navigate the
 * privileged, Node-capable window off-app (only same-page navigation is allowed),
 * and a `target="_blank"`/`window.open` opens http(s) in the OS browser and is
 * denied an in-app window. Registering it on `web-contents-created` means a future
 * window/webview inherits the policy by construction rather than by remembering to
 * re-wire it. (Today: `webviewTag` is off and only one window is created.)
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!isInAppUrl(url, appUrl)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const external = externalOpenTarget(url);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });
});

// Wire the IPC boundary once, before any window exists. Use the real local
// runtime; if it can't be constructed (e.g. before the Ollama/docling sidecars
// are installed) fall back to an HONEST degraded API that reports the runtime as
// down and refuses to fabricate results — never the demo stub, which would
// report healthy and emit passing accessibility badges (C3).
registerIpc(ipcMain, buildApi(createAppApi));

void app.whenReady().then(() => {
  // This on-device app needs no device permissions (camera/mic/geo/notifications/
  // etc.). Deny every permission request so gated content can never prompt for or
  // obtain one — a free backstop on top of the strict CSP + sandboxed preview frame.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  createWindow();

  // macOS: re-create a window when the dock icon is clicked and none are open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard non-macOS behaviour; on macOS apps typically stay alive.
  if (process.platform !== 'darwin') app.quit();
});

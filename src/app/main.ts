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
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerIpc } from './ipc.js';
import { buildApi } from './build-api.js';
import { isInAppUrl, externalOpenTarget } from './navigation.js';
import { createAppApi } from '../runtime/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

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

  const indexPath = path.join(here, 'renderer', 'index.html');
  const appUrl = pathToFileURL(indexPath).toString();

  // C8: never let a link in gated content navigate the privileged, Node-capable
  // window off-app. Only same-page navigation (in-page anchors / reload) is allowed.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isInAppUrl(url, appUrl)) event.preventDefault();
  });
  // A `target="_blank"` (or window.open) request: open http(s) in the OS browser,
  // deny everything else, and never spawn an in-app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalOpenTarget(url);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });

  void win.loadFile(indexPath);
}

// Wire the IPC boundary once, before any window exists. Use the real local
// runtime; if it can't be constructed (e.g. before the Ollama/docling sidecars
// are installed) fall back to an HONEST degraded API that reports the runtime as
// down and refuses to fabricate results — never the demo stub, which would
// report healthy and emit passing accessibility badges (C3).
registerIpc(ipcMain, buildApi(createAppApi));

void app.whenReady().then(() => {
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

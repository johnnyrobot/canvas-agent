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
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerIpc } from './ipc.js';
import { createStubApi } from './stub-api.js';

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
      sandbox: true,
    },
  });

  void win.loadFile(path.join(here, 'renderer', 'index.html'));
}

// Wire the IPC boundary once, before any window exists. ⟵ integration seam.
registerIpc(ipcMain, createStubApi());

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

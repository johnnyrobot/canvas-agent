/**
 * Electron main process — the only place that boots a `BrowserWindow`.
 *
 * Kept deliberately thin: all testable logic lives in the modules it wires —
 * `ipc.ts` (the IPC boundary), `build-api.ts` (the C3 fallback policy),
 * `shutdown.ts` (quit sequencing), and `../runtime` (the composition root that
 * owns the sidecar processes). This file creates the window with secure
 * defaults, wires the IPC surface to the runtime's `AppApi`, and connects that
 * runtime's `dispose` to quit.
 *
 * Not unit-tested (Electron can't launch headless under `node:test`); its
 * behaviour is covered by those modules' own suites, the scripted E2E matrix,
 * and a real-app smoke.
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerIpc } from './ipc.js';
import { buildApi } from './build-api.js';
import { registerShutdown } from './shutdown.js';
import { createE2eAppApi } from './e2e-api.js';
import { isInAppUrl, externalOpenTarget } from './navigation.js';
import { withScreenshotCapture } from './screenshot.js';
import { createRuntime } from '../runtime/index.js';
import type { RuntimeHandle } from '../runtime/index.js';
import { resolveSidecarCommand, resolveIngestModelEnv } from '../runtime/bundled-resources.js';
import { ensureCatalogHome } from '../runtime/catalog-home.js';
import { createCatalogClient } from '../catalog/index.js';
import { resolveAppPaths } from '../storage/index.js';
import type { ScreenshotPermissionStatus } from '../contracts/index.js';

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

/**
 * Packaged app only: point the catalog client at the bundled
 * `laccd-courses-pp-cli` binary and a writable `--home` seeded (once) from the
 * bundled read-only seed DB. In dev (not packaged) this returns `undefined`,
 * and `createAppApi`'s `opts.catalog ?? createCatalogClient()` falls back to
 * the PATH default unchanged.
 *
 * Catalog enrichment is documented as NEVER a hard runtime dependency
 * (`app-api.ts`'s `catalog` option: `catalogAvailable()` degrades to `false`
 * rather than throwing). `ensureCatalogHome` does a synchronous ~900 MB
 * `copyFileSync` of the seed on first launch, so if the seed isn't staged at
 * the expected path, or the copy fails (disk full, interrupted, permissions),
 * it throws synchronously — and an uncaught throw here would propagate out of
 * `createRuntimeHandle()` into `buildApi`'s catch, degrading the ENTIRE app (dead
 * chat/build/remediate), not just the catalog panel. Guard against that: any
 * failure here logs a warning and returns `undefined`, so only catalog
 * enrichment degrades, exactly like every other bundled-resource resolution.
 */
function packagedCatalogClient() {
  if (!app.isPackaged || !process.resourcesPath) return undefined;
  try {
    const command = resolveSidecarCommand('laccd-courses-pp-cli');
    const seedDbPath = path.join(process.resourcesPath, 'sidecars', 'laccd-courses-pp-cli', 'seed', 'data.db');
    const home = ensureCatalogHome({ seedDbPath, homeDir: resolveAppPaths().catalogHomeDir });
    return createCatalogClient({ command, home });
  } catch (err) {
    console.warn('[catalog] bundled catalog unavailable; enrichment disabled:', err);
    return undefined;
  }
}

function createRuntimeHandle(): RuntimeHandle {
  if (process.env.CANVAS_AGENT_E2E_API === 'scripted') {
    // The scripted E2E API owns no processes, so it has nothing to tear down.
    return { api: createE2eAppApi(process.env.CANVAS_AGENT_E2E_SCENARIO), dispose: async () => {} };
  }
  // Which model store Docling serves from. Every branch — dev, operator override,
  // bundled models, per-user store — lives in the resolver, which is pure and
  // unit-tested; this file imports Electron and cannot be (ADR-0006).
  Object.assign(
    process.env,
    resolveIngestModelEnv({
      packaged: app.isPackaged,
      userModelsDir: resolveAppPaths().modelsDir,
      env: process.env,
    }),
  );
  // `exactOptionalPropertyTypes` treats `{ catalog: undefined }` as distinct from
  // omitting the key, so the key is only included when a packaged client exists;
  // omitting it (dev) still falls through to `opts.catalog ?? createCatalogClient()`.
  const catalog = packagedCatalogClient();
  const runtime = createRuntime(catalog ? { catalog } : {});
  // The screenshot decorator wraps the API surface only; process lifetime is not
  // its concern, so `dispose` passes through untouched.
  return {
    api: withScreenshotCapture(runtime.api, {
      permissionStatus: () =>
        systemPreferences.getMediaAccessStatus('screen') as ScreenshotPermissionStatus,
      getSources: (options) => desktopCapturer.getSources(options),
      now: () => new Date().toISOString(),
      randomId: () => randomUUID(),
    }),
    dispose: runtime.dispose,
  };
}

// Wire the IPC boundary once, before any window exists. Use the real local
// runtime; if it can't be constructed (e.g. before the Ollama/docling sidecars
// are installed) fall back to an HONEST degraded API that reports the runtime as
// down and refuses to fabricate results — never the demo stub, which would
// report healthy and emit passing accessibility badges (C3).
const runtime = buildApi(createRuntimeHandle);
registerIpc(ipcMain, runtime.api);

// Stop the sidecars we own when the app quits (#13, ADR-0006). Without this the
// app orphans `ollama serve` and `docling-serve` on every quit, and repeated
// launch/quit cycles stack them up holding model weights in memory.
registerShutdown(app, runtime.dispose);

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

// Ctrl-C on `npm run app` kills Electron WITHOUT firing `before-quit`, so the dev
// inner loop leaks the sidecars exactly as a shipped quit used to. Route both
// signals through `app.quit()` so they land in the same shutdown handler.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.quit();
  });
}

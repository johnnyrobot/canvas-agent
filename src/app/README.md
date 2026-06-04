# `src/app` — the Electron desktop shell

The single-user macOS app that wraps the local runtime (`AppApi`) in a window:
the user types a request, sees the assistant's reply, and sees the **gated** HTML
fragments with a pass / "checks withheld" badge (PRD §19–§22).

This track depends on **nothing but the frozen contract types** (`src/contracts`).
It never imports the integration runtime (`src/runtime/*`). It ships its own
`createStubApi(): AppApi` (canned data) so the app runs standalone; the lead
swaps the stub for the real `createAppApi` after the tracks merge — that single
argument to `registerIpc` is the only integration seam.

## Layout

| File | Tested? | Responsibility |
|---|---|---|
| `channels.ts` | ✅ | Exported IPC channel-name constants (`RUN_TURN`, `IMPORT_CANVAS`, `HEALTH`) — one source of truth for both sides of the bridge. |
| `ipc.ts` | ✅ | PURE `registerIpc(ipcMain, api)` — wires each channel to an `AppApi` method, wrapping results/errors in an `{ ok, value \| error }` envelope. Tested with a fake `ipcMain` + fake `AppApi`. |
| `bridge.ts` | ✅ | PURE `createBridge(invoke)` — builds the renderer-side object mirroring `AppApi`; invokes channels and unwraps the envelope (re-throwing real errors). |
| `stub-api.ts` | ✅ | `createStubApi(): AppApi` — canned `TurnView` (one passing-gate fragment + one `badgeWithheld` fragment), `CanvasImportResult`, `RuntimeHealth`. |
| `view.ts` | ✅ | PURE `turnViewToVm(view)` — maps a `TurnView` to a render-ready VM; derives the badge from the gate (never the model). |
| `main.ts` | smoke | Electron `app`/`BrowserWindow` bootstrap with secure defaults; `registerIpc(ipcMain, createStubApi())`. |
| `preload.ts` | smoke | `contextBridge.exposeInMainWorld('canvasAgent', createBridge(ipcRenderer.invoke))`. |
| `renderer/index.html` + `renderer/renderer.ts` | smoke | Minimal vanilla-TS UI: prompt box, transcript, fragment rendering with badges. |
| `index.ts` | — | Public surface — re-exports ONLY the Electron-free pieces (safe to import from `node:test` / the integration track). |

## Architecture

```
renderer (sandboxed browser, no Node)
   │  window.canvasAgent.runTurn(...)            ← createBridge() (bridge.ts)
   ▼  ipcRenderer.invoke(CHANNEL, …args)         ← preload.ts (contextBridge)
main process
   │  ipcMain.handle(CHANNEL, …)                 ← registerIpc() (ipc.ts)
   ▼  api.runTurn(...) / importCanvas / health   ← AppApi
AppApi = createStubApi()  ⟵ integration seam ⟶  createAppApi()  (lead, post-merge)
```

Everything testable lives **outside** the Electron entry points. `main.ts` /
`preload.ts` only bind the pure pieces to `electron`, so the `electron` import is
confined to those two files and never reaches the `node:test` path.

### Security defaults
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The renderer reaches main **only** through the typed `canvasAgent` preload
  bridge — no `ipcRenderer`/Node in the renderer.
- A strict CSP in `index.html` (`default-src 'none'; script-src 'self'`) — the
  app is fully on-device, so the renderer needs no remote origins.

### The output gate is the sanitizer
The renderer injects each fragment's `gate.html` via `innerHTML`. That is **by
design**: `gate.html` is the output of the unconditional allowlist + audit gate
(`enforceGate`, PRD §8.6) and is therefore Canvas-safe. All user/assistant *text*
is written with `textContent` and never interpolated as HTML.

## Running (manual smoke)

`npm test` stays **offline and never launches Electron**. The real window is a
manual smoke. The lead adds an `npm run app` script post-merge; until then the
equivalent steps are:

```bash
# 1. install the Electron binary (the dev install here skipped it for speed)
npm install            # or: npm rebuild electron

# 2. compile TS → dist/ (emits dist/app/main.js, preload.js, renderer/renderer.js)
npm run build

# 3. copy the static renderer assets tsc doesn't emit (.html/.css)
mkdir -p dist/app/renderer && cp src/app/renderer/index.html dist/app/renderer/

# 4. launch
npx electron .
```

The suggested `npm run app` the lead will add bundles steps 2–4, e.g.
`tsc && cp src/app/renderer/index.html dist/app/renderer/ && electron .`.
(Electron runs `main.js` as ESM — `"type": "module"` + Electron ≥ 28.)

## Packaging plan (config only — not run here)

The electron-builder `build` block lives in `package.json`:

- **`appId`** `ai.johnnyrobot.canvasagent`, **`productName`** `Canvas Agent`,
  **`directories.output`** `release/`.
- **`mac.target`**: `dmg` + `zip`, **arm64** (Apple Silicon — the Ollama MLX
  engine and Granite-Docling MLX runs are arm64).
- **`extraResources`** reserve space for the two bundled sidecars, copied into
  the packaged app's `Resources/sidecars/`:
  - `resources/sidecars/ollama` → `sidecars/ollama` (the Ollama server + the
    resident Gemma model, or a first-run fetch).
  - `resources/sidecars/docling-serve` → `sidecars/docling-serve` (the Python
    `docling-serve` ingestion sidecar, e.g. a PyInstaller bundle).

### What the lead must add before packaging (out of scope to run here)
1. **Create + populate the sidecar dirs.** `resources/sidecars/ollama` and
   `resources/sidecars/docling-serve` must exist (electron-builder errors on a
   missing `extraResources.from`). They're intentionally **not** created in this
   track — this track owns only `src/app/`. At runtime the main process resolves
   them via `process.resourcesPath`/`sidecars/...`.
2. **Renderer asset copy.** Ensure `index.html` (and any future `.css`) lands in
   `dist/app/renderer/` next to the compiled `renderer.js` before `electron-builder`
   packs `dist/**`.
3. **Code signing.** `mac.hardenedRuntime: true` is set and an
   `build-resources/entitlements.mac.plist` is referenced (allow JIT / unsigned
   executable memory for the bundled runtimes, plus network-client for the
   localhost sidecars). Signing needs a real **Apple Developer ID Application**
   certificate in the keychain (`CSC_LINK`/`CSC_KEY_PASSWORD`).
4. **Notarization.** After signing, notarize with `notarytool` (Apple ID +
   app-specific password or an API key via `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`
   or `APPLE_API_KEY`), then staple. **Requires a paid Apple Developer account —
   out of scope to execute in this track.**

Until certs exist, `electron-builder --mac` still produces an **unsigned**
`.dmg`/`.zip` for local testing (`gatekeeperAssess: false`).

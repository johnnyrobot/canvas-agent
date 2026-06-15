# Releasing Canvas Agent — pre-release checklist

The named, must-be-GREEN sequence before tagging a release (SHIP-READINESS
blocker #3). Run on **Apple-Silicon (arm64) hardware** with the on-device stack
installed (Ollama + docling-serve) and a Chromium browser available. Each step
must pass before the next.

> The offline inner loop (`npm run verify`) is enforced automatically by the
> committed `githooks/pre-push` hook (wired by `npm install` / `npm run install:hooks`).
> The steps below are what a *tag* additionally requires — the things the default
> test suite deliberately does not touch.

## 1. Offline gate (fast; also the pre-push hook)

```sh
npm run verify          # tsc --noEmit && npm test  → 0 fail, 13 env-gated skips
npm run audit:prod      # npm audit --omit=dev --audit-level=high → 0 (prod deps clean)
```

## 2. Real on-device stack (the env-gated integration tests)

These prove the things only real hardware can — the Chromium+axe auditor behind
every badge, and the Ollama/Docling sidecars:

```sh
RUN_BROWSER_INTEGRATION=1 npx tsx --test src/engine/render/integration.test.ts
RUN_BROWSER_INTEGRATION=1 npx tsx --test src/templates/audit.test.ts
RUN_OLLAMA_INTEGRATION=1 RUN_DOCLING_INTEGRATION=1 npx tsx --test e2e/live.test.ts
```

## 3. Stage the bundled payloads

The large binaries are not committed (see `resources/STAGING.md`):

```sh
npm run stage:browsers                                   # Chromium → resources/ms-playwright
OLLAMA_BIN="$(command -v ollama)" \
  DOCLING_SERVE_DIR="/path/to/docling-serve"  \
  npm run stage:sidecars                                 # sidecars → resources/sidecars/*
npm run pre-release -- --strict                          # asserts paths exist, payloads + sidecar launchers staged
```

> `DOCLING_SERVE_DIR` must be the docling-serve **onedir app dir** — the directory
> whose *immediate child* is the `docling-serve` launcher (e.g. PyInstaller's
> `.../dist/docling-serve`), **not** the parent `dist/`. The runtime spawns the
> sidecar from the fixed leaf `<Resources>/sidecars/docling-serve/docling-serve`;
> `stage:sidecars` asserts the launcher lands there and `pre-release --strict`
> re-checks it, so a mis-stage fails before electron-builder ever runs.

## 4. Build, sign & notarize the DMG

Signing needs a **Developer ID Application** identity in the login keychain
(electron-builder auto-discovers it). Notarization is enabled in config
(`mac.notarize: true`), so the build will **submit to Apple's notary service and
staple the ticket** — it requires credentials in the environment. Provide ONE set
(API key recommended — see electron-builder issue #7859):

```sh
# Option A (recommended): App Store Connect API key
export APPLE_API_KEY="/path/to/AuthKey_XXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXX"
export APPLE_API_ISSUER="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

# Option B: Apple ID + app-specific password
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"

# Option C (used for the 0.1.0 build): a stored notarytool keychain profile.
# Do NOT also set APPLE_KEYCHAIN to a path — store-credentials items are not found by
# an explicit --keychain lookup, which makes notarization fail.
export APPLE_KEYCHAIN_PROFILE="canvas-agent-notary"   # from `xcrun notarytool store-credentials`

npm run package   # build → pre-release --strict → electron-builder --mac → make-dmg.sh
```

`npm run package` re-runs the strict pre-release gate first, so a build can never
be cut against missing/unstaged paths. That gate also **requires** one of the
credential families above whenever `mac.notarize` is on — which matters because
electron-builder itself does **not** fail on missing credentials: it logs a warning,
skips notarization, and still emits a *signed-but-un-notarized* DMG that Gatekeeper
rejects on other Macs. The `--strict` pre-flight turns that silent skip into a hard
failure, so `npm run package` is genuinely fail-closed. (Dev runs use `npm run app`
/ `electron .`, which never invoke electron-builder, so day-to-day work is unaffected.)

electron-builder notarizes + staples the **.app** (and emits the auto-update **.zip**).
Its own `dmg` target is **disabled** — it corrupts the bundled framework signatures (the
Electron Framework reads "not signed at all" inside its image, so the dmg fails
notarization). `scripts/make-dmg.sh` — chained into `npm run package` — builds the
shippable dmg from the signed .app with `ditto`+`hdiutil` (a faithful copy) and notarizes
+ staples it.

Confirm both artifacts after the build:

```sh
xcrun stapler validate "release/mac-arm64/Canvas Agent.app"
spctl -a -vvv -t install "release/mac-arm64/Canvas Agent.app"        # → accepted, Notarized Developer ID
xcrun stapler validate "release/Canvas Agent-<version>-arm64.dmg"
spctl -a -vvv -t open --context context:primary-signature \
  "release/Canvas Agent-<version>-arm64.dmg"                         # → accepted, Notarized Developer ID
```

## 5. Packaged-artifact smoke (proves asar/path/preload/resourcesPath + the bundled gate)

```sh
RUN_PACKAGED_SMOKE=1 CANVAS_AGENT_APP="release/mac-arm64/Canvas Agent.app" \
  npx tsx --test e2e/packaged-smoke.test.ts
```

Asserts: the preload bridge loads in the packaged renderer, `health()` resolves
over IPC, and a build turn's emitted HTML is gated by the **bundled** Chromium
auditor (the `process.resourcesPath → ms-playwright` resolution works end to end).

---

A tag is GREEN only when **all five** steps pass on arm64. Steps 2 + 5 are the
ones the offline suite cannot stand in for — do not skip them.

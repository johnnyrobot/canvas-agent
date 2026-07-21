# `resources/` — bundled payloads for the packaged `.app`

electron-builder copies everything here into `Canvas Agent.app/Contents/Resources/`
(see `build.extraResources` in `package.json`). The large binaries are **not**
committed to git — they are *staged* on the build machine before packaging. The
directory structure + this doc are committed so the layout is self-describing and
`scripts/pre-release.mjs` can verify it.

| Path                         | Bundled to (`process.resourcesPath`) | Staged by |
|------------------------------|---------------------------------------|-----------|
| `ms-playwright/`             | `ms-playwright/`                      | `npm run stage:browsers` |
| `sidecars/ollama/`           | `sidecars/ollama/`                    | `npm run stage:sidecars` |
| `sidecars/docling-serve/`    | `sidecars/docling-serve/`             | `npm run stage:sidecars` |
| `sidecars/laccd-courses-pp-cli/` | `sidecars/laccd-courses-pp-cli/`  | `node scripts/build-catalog-seed.mjs` (seed) + `npm run stage:sidecars` (binary) |

## How the runtime finds these

- **Chromium (the accessibility gate):** `playwright-runner.ts`
  (`resolveBundledBrowsersPath`) sets `PLAYWRIGHT_BROWSERS_PATH` to
  `<Resources>/ms-playwright` at launch, so `chromium.launch()` resolves the
  bundled browser instead of a dev-only `~/.cache/ms-playwright`.
- **Sidecars (Ollama, docling-serve, laccd-courses-pp-cli):** `resolveSidecarCommand`
  (`src/runtime/bundled-resources.ts`) spawns each from the fixed leaf
  `<Resources>/sidecars/<name>/<name>` (so `sidecars/ollama/ollama`,
  `sidecars/docling-serve/docling-serve`). A Finder-launched `.app` has a minimal
  PATH, so the bundled absolute path is required; the resolver falls back to a
  bare-PATH lookup only in dev. `stage:sidecars` + `pre-release --strict` both
  assert the launcher is at that leaf.
- **Catalog seed:** the bundle is read-only, but the CLI needs a writable store, so
  the app copies `sidecars/laccd-courses-pp-cli/seed/data.db` into
  `<userData>/catalog-home/data/` on first run (`ensureCatalogHome`, atomically via
  temp+rename). Both `stage:sidecars` and `pre-release --strict` assert the seed is
  present — a binary without it yields a silent, always-empty offline search.

## Staging before a release build

```sh
# 1. Chromium for the audit engine (downloads the pinned revision into resources/)
npm run stage:browsers

# 2. The course-catalog seed (~898 MB). SLOW — it mirrors the full district
#    catalog, then trims and self-verifies it via the real CLI. Do this before
#    staging: stage:sidecars refuses to stage the binary without a seed.
CATALOG_CLI_BIN="$(command -v laccd-courses-pp-cli)" \
node scripts/build-catalog-seed.mjs

# 3. The on-device sidecar binaries (point at your local installs).
#    DOCLING_SERVE_DIR = the onedir app dir whose immediate child is the
#    `docling-serve` launcher (e.g. .../dist/docling-serve), NOT the parent `dist`.
OLLAMA_BIN="$(command -v ollama)" \
DOCLING_SERVE_DIR="/path/to/docling-serve" \
CATALOG_CLI_BIN="$(command -v laccd-courses-pp-cli)" \
npm run stage:sidecars

# 4. Verify the build config is coherent and every payload is present
npm run pre-release -- --strict

# 5. Package (the package script re-runs the strict pre-release gate first)
npm run package
```

A fresh checkout has empty payload dirs; `npm run pre-release` (non-strict)
validates structure, while `--strict` (used by `npm run package`) additionally
requires the real staged binaries so a broken/un-staged DMG can never be cut.

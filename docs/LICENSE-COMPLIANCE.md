# License & Redistribution Compliance

**Scope:** the components actually bundled in and distributed by the Canvas Agent
macOS `.app`/`.dmg`, and their redistribution obligations.
**Last reviewed:** 2026-06-25 (against the `chromium-headless-shell` build).
**Status:** all redistributed components are under permissive licenses; no copyleft
weights, no proprietary DRM, no Google-binary terms. See residual items at the end.

> This document records an engineering license review, not legal advice. Final
> sign-off for distribution is a human/legal decision.

## What is redistributed (bundled in the `.dmg`)

| Component | License | Redistribution status |
|---|---|---|
| Electron + embedded Chromium / Node / V8 | MIT / BSD-3-Clause | ✅ permissive; notices shipped in-framework |
| axe-core | MPL-2.0 | ✅ used unmodified; file-level copyleft satisfied |
| Playwright (npm) | Apache-2.0 | ✅ permissive |
| Chromium **headless shell** (`chromium-headless-shell`) | BSD-3-Clause | ✅ permissive; `LICENSE.headless_shell` shipped |
| Ollama runner set (+ llama.cpp/ggml, MLX) | MIT | ✅ permissive; no weights bundled |
| docling / docling-serve | MIT | ✅ permissive (Python deps: see residual #2) |
| Docling models ×4 (CodeFormulaV2, layout-heron, docling-models, DocumentFigureClassifier) | CDLA-Permissive-2.0 / Apache-2.0 / MIT | ✅ permissive; redistributable with attribution |
| RapidOCR / PaddleOCR PP-OCRv4 weights | Apache-2.0 | ✅ permissive |

## What is NOT redistributed

| Component | Why it's not an obligation |
|---|---|
| **Gemma** LLM weights | Pulled at runtime by Ollama; the user obtains them directly under Google's Gemma Terms. Not bundled. |
| **Widevine CDM** (proprietary DRM) | Removed — we ship the BSD headless shell, not "Chrome for Testing." |
| **"Google Chrome for Testing"** binary | Removed for the same reason. |
| Playwright's **standalone FFmpeg** (LGPL-2.1+) | Removed — only needed for video recording, which the app never does. Excluded from the bundle (`build.extraResources` filter). |

> **Note — Electron's `libffmpeg.dylib`:** Electron's embedded Chromium ships its own
> `libffmpeg.dylib` (LGPL-2.1+, ~2 MB), present in *every* Electron app. It is
> dynamically linked (LGPL-replaceable) and its license is in Electron's
> `LICENSES.chromium.html`. This is the standard, accepted Electron posture; it is
> distinct from the Playwright standalone FFmpeg removed above.

## Remediation applied (2026-06-25)

To eliminate the proprietary/copyleft redistribution exposure that the full
Playwright Chromium carried, the audit engine was switched to Playwright's
open-source **`chromium-headless-shell`** channel:

- `src/engine/render/playwright-runner.ts` — launches with
  `channel: 'chromium-headless-shell'`.
- `package.json` — `stage:browsers` installs `chromium-headless-shell`; the
  `ms-playwright` `extraResources` filter excludes `ffmpeg-*`.
- Validated: the real-browser audit suites pass on the headless shell
  (`RUN_BROWSER_INTEGRATION=1`), including the screenshot-based contrast paths.
- Side effect: the bundle shrank ~340 MB.

## Residual items for human/legal sign-off

1. **Gemma user-facing terms.** Weights aren't redistributed, but the app defaults
   to a Gemma model and directs users to obtain it. Best practice (and arguably
   required) is to surface the Gemma Terms of Use + Prohibited Use Policy to the
   user in-app or in docs. *Recommended: add a first-run/about notice.*
2. **docling-serve Python dependency tree.** The 2.8 GB sidecar bundles a large
   PyTorch dependency set assumed permissive (BSD/Apache/MIT). *Recommended:
   run a license scan (e.g. `pip-licenses`) over the bundled environment to confirm
   no copyleft (GPL/LGPL) package slipped in.*
3. **Final legal review.** This is an engineering review; a human/lawyer should give
   the distribution sign-off, especially regarding the Gemma Terms pass-through.

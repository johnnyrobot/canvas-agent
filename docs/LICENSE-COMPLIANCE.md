# License & Redistribution Compliance

**Scope:** the components actually bundled in and distributed by the Canvas Agent
macOS `.app`/`.dmg`, and their redistribution obligations.
**Last reviewed:** 2026-07-04 (updated to reflect the 0.2.0 first-run Docling
model-download architecture; originally reviewed 2026-06-25 against the
`chromium-headless-shell` build).
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
| RapidOCR / PaddleOCR PP-OCRv4 weights | Apache-2.0 | ✅ permissive |

## What is NOT redistributed

| Component | Why it's not an obligation |
|---|---|
| **Gemma** LLM weights | Pulled at runtime by Ollama; the user obtains them directly under Google's Gemma Terms. Not bundled. |
| **Docling models** ×4 (CodeFormulaV2, layout-heron, docling-models, DocumentFigureClassifier) | Pulled at runtime by the first-run Docling model-download step (`src/ingest/model-download.ts`), not shipped in the `.dmg`. Licenses (CDLA-Permissive-2.0 / Apache-2.0 / MIT) remain permissive; there is simply no bundling obligation since 0.2.0. Not bundled. (Moved here 2026-07-04 to match the implementation — see the doc audit.) |
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

## Follow-up items — resolved (2026-06-25)

1. **Gemma user-facing terms — DONE.** The app's renderer now shows a persistent,
   accessible footer notice that it runs Google's Gemma on-device and that use is
   subject to the Gemma Terms of Use and Prohibited Use Policy (links to
   `ai.google.dev/gemma/terms` and `…/prohibited_use_policy`), and that the app is
   Apache-2.0 with third-party components in `THIRD-PARTY-NOTICES.md`
   (`src/app/renderer/index.html`).
2. **docling-serve Python dependency scan — DONE.** All 231 bundled packages were
   license-scanned (`*.dist-info` METADATA, incl. PEP 639 `License-Expression`).
   Result: **no GPL or AGPL**. Findings: `certifi` + `tqdm` (MPL-2.0, weak file-level
   copyleft); `paramiko` (LGPL-2.1 — SSH lib, shipped unmodified as source → LGPL
   satisfied, replaceable, and almost certainly an unused transitive dep). Everything
   else MIT/Apache-2.0/BSD/PSF. Full inventory: `docs/docling-python-licenses.txt`.

## Final attestation & sign-off

**Engineering license review: COMPLETE.** Every component redistributed in the
`.dmg` has been identified and verified against its actual license; all are
permissive or weak-copyleft satisfiable as bundled; no GPL/AGPL, no proprietary DRM,
no Google-binary (Chrome-for-Testing) terms. Required notices and user-facing terms
are in place.

This remains an **engineering** review. The final distribution **sign-off is a human
(legal/business) decision** — in particular confirming comfort with the Gemma Terms
pass-through and the weak-copyleft components (MPL-2.0 `certifi`/`tqdm`, LGPL-2.1
`paramiko`, Electron's `libffmpeg.dylib`). This document + the inventory are the
record to support that sign-off.

Reviewer: automated engineering review (Claude). Date: 2026-06-25. Build: `main` @ the
`chromium-headless-shell` packaging commit.

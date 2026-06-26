# Third-Party Notices

Canvas Agent is an on-device macOS application. It incorporates, links against, or
bundles the third-party software listed below. Each component remains under its own
license; the relevant copyright notices and license summaries are reproduced here.
Full license texts ship with each component — inside `node_modules/<pkg>/LICENSE`
for the npm dependencies, and alongside each bundled binary in the application's
`Contents/Resources` directory.

This file is a good-faith attribution summary, not legal advice. Versions reflect
the dependencies pinned at release time (`package.json`).

---

## Bundled application code (npm dependencies)

### axe-core — 4.12.x
- **License:** Mozilla Public License 2.0 (MPL-2.0)
- **Copyright:** © Deque Systems, Inc.
- **Use:** the accessibility rule engine, injected into the headless render to scan
  generated HTML. Source: <https://github.com/dequelabs/axe-core>.
- MPL-2.0 is a file-level copyleft license; the unmodified axe-core source is
  available from the project above and in `node_modules/axe-core`.

### Playwright (`playwright`, `playwright-core`) — 1.60.x
- **License:** Apache License 2.0
- **Copyright:** © Microsoft Corporation
- **Use:** drives the headless Chromium that renders fragments for the audit engine.
  Source: <https://github.com/microsoft/playwright>.

## Application shell

### Electron — 42.x
- **License:** MIT
- **Copyright:** © GitHub, Inc. and the Electron contributors
- **Use:** the desktop application runtime. Source: <https://github.com/electron/electron>.
- Electron itself embeds **Chromium** (BSD-3-Clause and other licenses, © The
  Chromium Authors), **Node.js** (MIT, © Node.js contributors and Joyent, Inc.),
  and **V8** (BSD-3-Clause, © The V8 project authors). Their full notices ship
  inside the Electron framework (`LICENSE`, `LICENSES.chromium.html`).
- Electron's embedded Chromium includes a dynamically-linked **`libffmpeg.dylib`**
  (`Contents/Frameworks/Electron Framework.framework/.../Libraries/libffmpeg.dylib`)
  built from **FFmpeg** (LGPL-2.1-or-later, © the FFmpeg authors). As a separate,
  dynamically-loaded library it satisfies the LGPL (replaceable by the user); its
  license is included in Electron's `LICENSES.chromium.html`. This is the standard
  Electron media library and is distinct from Playwright's standalone FFmpeg, which
  is **not** bundled (see below).

## Bundled on-device binaries (staged into `Contents/Resources` at release time)

These are not committed to the repository; they are installed locally and staged by
the `stage:*` scripts. They are distributed under their own licenses:

### Chromium — headless shell (Playwright `chromium-headless-shell`)
- **License:** BSD-3-Clause (plus the licenses of its third-party components)
- **Copyright:** © The Chromium Authors
- **Use:** the open-source Chromium **headless shell** behind every accessibility
  audit (headless rendering + screenshots only). Staged via
  `npx playwright install chromium-headless-shell`; the full license text ships
  beside the binary in `Contents/Resources/ms-playwright`
  (`LICENSE.headless_shell`).
- **Not bundled:** the full "Google Chrome for Testing" build, its **Widevine CDM**
  (proprietary), and Playwright's **standalone FFmpeg** binary (used only for video
  recording, which this app never does) are deliberately excluded — the app only
  needs headless rendering, so none of those components are staged or redistributed.
  (This is separate from Electron's own embedded `libffmpeg.dylib`, covered above.)

### Ollama
- **License:** MIT
- **Copyright:** © Ollama, Inc. and contributors
- **Use:** the local LLM inference server (`ollama serve`), bundled as its full
  Apple-Silicon runner set (`ollama` + `llama-server` + `libggml`/`libllama` +
  `mlx_metal_*`). Source: <https://github.com/ollama/ollama>. Ollama statically
  links **llama.cpp / ggml** (MIT, © the ggml authors,
  <https://github.com/ggml-org/llama.cpp>) and bundles **MLX** (MIT, © Apple Inc.,
  <https://github.com/ml-explore/mlx>); their full MIT texts are available from
  those projects. **No model weights are bundled with Ollama** (see below).

### Docling / `docling-serve`
- **License:** MIT
- **Copyright:** © IBM Corp. and the Docling contributors
- **Use:** the local document-ingestion sidecar. Source:
  <https://github.com/docling-project/docling> and
  <https://github.com/docling-project/docling-serve>. docling-serve is bundled as a
  Python/PyTorch application; the licenses of its bundled Python dependencies (BSD,
  Apache-2.0, MIT, and others) ship beside the binary in
  `Contents/Resources/sidecars/docling-serve` and are incorporated here by reference.

## Bundled model weights (redistributed inside the app)

The document-ingestion sidecar bundles the following models, which are
redistributed inside the application. All are under permissive licenses:

| Model | License | Source |
|---|---|---|
| `docling-project/CodeFormulaV2` | CDLA-Permissive-2.0 | <https://huggingface.co/docling-project> |
| `docling-project/docling-layout-heron` | Apache-2.0 | <https://huggingface.co/docling-project> |
| `docling-project/docling-models` (TableFormer) | CDLA-Permissive-2.0 | <https://huggingface.co/docling-project> |
| `docling-project/DocumentFigureClassifier-v2.5` | MIT | <https://huggingface.co/docling-project> |
| RapidOCR (PaddleOCR **PP-OCRv4** weights) | Apache-2.0 | <https://github.com/RapidAI/RapidOCR>, <https://github.com/PaddlePaddle/PaddleOCR> |

Each model's card (`README.md`) ships alongside its weights in
`Contents/Resources/sidecars/docling-serve/models`.

## Model weights used at runtime (NOT redistributed)

The on-device LLM weights are **pulled and run locally** by Ollama at runtime; they
are **not** bundled in or redistributed with this application:

- **Gemma** (the app's default model, run via Ollama's MLX runner) — Google
  **Gemma Terms of Use** (<https://ai.google.dev/gemma/terms>) and the Gemma
  **Prohibited Use Policy** (<https://ai.google.dev/gemma/prohibited_use_policy>).
  Users obtain the weights directly through Ollama and are bound by these terms.

---

### License summaries

- **MIT** and **BSD-3-Clause** are permissive licenses permitting reuse with
  attribution and inclusion of the copyright/permission notice.
- **Apache-2.0** is permissive with an explicit patent grant; modifications must be
  marked and the NOTICE preserved where present.
- **CDLA-Permissive-2.0** (Community Data License Agreement – Permissive 2.0) is a
  permissive license for data/model artifacts: redistribution is allowed with the
  license text retained; it adds no copyleft obligation to the using software.
- **MPL-2.0** is a weak (file-level) copyleft license; the covered source files must
  remain available under MPL-2.0, which they are at the upstream project and in
  `node_modules/axe-core`.

Full, unmodified license texts are available in each dependency's package directory
and from the linked upstream projects.

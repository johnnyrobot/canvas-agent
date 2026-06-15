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

## Bundled on-device binaries (staged into `Contents/Resources` at release time)

These are not committed to the repository; they are installed locally and staged by
the `stage:*` scripts (see `resources/STAGING.md`). They are distributed under their
own licenses:

### Chromium (Playwright build)
- **License:** BSD-3-Clause (plus the licenses of its third-party components)
- **Copyright:** © The Chromium Authors
- **Use:** the headless browser behind every accessibility audit. Distributed by the
  Playwright project; full notices accompany the browser build.
- **Notable bundled component:** **FFmpeg** (`libffmpeg`) — LGPL-2.1-or-later,
  © the FFmpeg authors — is redistributed as a dynamic library inside the Chromium
  build. Its full license text ships alongside the browser in
  `Contents/Resources/ms-playwright`.

### Ollama
- **License:** MIT
- **Copyright:** © Ollama, Inc. and contributors
- **Use:** the local LLM inference server (`ollama serve`). Source:
  <https://github.com/ollama/ollama>. Ollama statically links `llama.cpp`/`ggml`
  (MIT) and other components; its own bundled license/NOTICE files ship beside the
  binary in `Contents/Resources/sidecars/ollama` and are incorporated here by reference.

### Docling / `docling-serve`
- **License:** MIT
- **Copyright:** © IBM Corp. and the Docling contributors
- **Use:** the local document-ingestion sidecar. Source:
  <https://github.com/docling-project/docling> and
  <https://github.com/docling-project/docling-serve>. docling-serve is bundled as a
  Python/PyTorch application; the licenses of its bundled dependencies (BSD,
  Apache-2.0, and others) ship beside the binary in
  `Contents/Resources/sidecars/docling-serve` and are incorporated here by reference.

## On-device model weights (used, not redistributed in this repository)

Model weights are pulled and run locally by the bundled inference/ingestion sidecars;
they are governed by their own terms:

- **Gemma** model weights — Google **Gemma Terms of Use**
  (<https://ai.google.dev/gemma/terms>). Run locally via Ollama.
- **Granite-Docling-258M** — Apache License 2.0, © IBM Corp. — used by Docling for
  document layout/conversion. Model card:
  <https://huggingface.co/ibm-granite/granite-docling-258M>.

---

### License summaries

- **MIT** and **BSD-3-Clause** are permissive licenses permitting reuse with
  attribution and inclusion of the copyright/permission notice.
- **Apache-2.0** is permissive with an explicit patent grant; modifications must be
  marked and the NOTICE preserved where present.
- **MPL-2.0** is a weak (file-level) copyleft license; the covered source files must
  remain available under MPL-2.0, which they are at the upstream project and in
  `node_modules/axe-core`.

Full, unmodified license texts are available in each dependency's package directory
and from the linked upstream projects.

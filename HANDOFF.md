# Canvas Agent — Session Handoff

**Date:** 2026-06-04 · **Status:** scaffolds complete & verified; ready to build the engine + app in parallel.
**Authoritative spec:** `PRD_Canvas_Course_Design_Accessibility_Assistant.md` (v1.6).
**Read this with:** the two project memories (`no-cloud-models-constraint`, `document-ingestion-stack`, `build-status-and-conventions`).

---

## 1. TL;DR — where we are

We have built and **verified** three TypeScript modules — the transport/orchestration skeleton — with mock-based tests. The **deterministic accessibility engine (the heart of the product) does not exist yet**; the orchestrator wires to it via dependency injection and stubs it with `NotImplementedError`. Next session begins building the real modules, parallelizable across tracks (see §6).

**Verified facts (re-run to confirm):**
- `npm run typecheck` → clean (strict TS: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `npm test` → **45 pass / 0 fail / 4 skipped** (the 4 skipped are the gated live-Ollama integration tests).
- **Zero runtime dependencies.** Only devDeps: `tsx`, `typescript`, `@types/node`.

---

## 2. Environment (this machine)

| Thing | State |
|---|---|
| Node | **v25.8.1** (package.json `engines` says `>=20`) |
| Package manager | npm; `node_modules/` present (tsx/typescript/@types/node only) |
| Git | **Not a git repo yet** (`git init` when ready to version) |
| `ollama` | ✅ installed (`/usr/local/bin/ollama`) — but `gemma4:12b-mlx` model **not pulled** |
| `docling-serve` | ❌ **not installed** (Python service for ingestion; `pip install docling-serve`) |
| `python3` | ✅ 3.13.7 (`/Library/Frameworks/Python.framework/...`) |
| Platform | macOS (darwin 25.5.0), Apple Silicon target |

**Stray files to ignore / clean later:** `firebase-debug.log`, `.DS_Store` (leftovers, unrelated to this project; not in scope).

### Run commands
```bash
npm run typecheck          # tsc --noEmit (strict)
npm test                   # tsx --test src/**/*.test.ts  (offline; mocks)
npm run build              # tsc → dist/
npm run llm:smoke          # tsx src/llm/example.ts  (needs live Ollama + model)

# To exercise the gated live-LLM integration tests:
#   1) ollama pull gemma4:12b-mlx
#   2) ollama serve   (or let OllamaProcess spawn it)
#   3) RUN_OLLAMA_INTEGRATION=1 npm test
```

---

## 3. Architecture invariants (DO NOT VIOLATE)

These are hard constraints from the PRD + user decisions. Every new module must honor them.

1. **No cloud models. No external network calls by default.** All inference is local (Ollama → Gemma 4 12B). No Anthropic/OpenAI/any hosted API, no cloud key, no fallback. The *only* opt-in external touches are the **read-only Canvas import** (PRD §17) and the **opt-in WAVE engine**. No telemetry, no cloud export, no image-fetch service (Pexels/Unsplash were removed). See memory `no-cloud-models-constraint`.
2. **The output gate is unconditional and server-side.** `src/orchestrator/gate.ts::enforceGate()` runs the allowlist + audit on *every* emitted HTML fragment regardless of what the model produced; a residual **blocker withholds the "passed checks" badge** (`A11Y_FAIL_OPEN=false`). The model is never trusted to self-certify. Removing a *semantic* element during allowlist repair is itself a blocker.
3. **Single-user Apple-Silicon desktop app.** SQLite + local files (not Postgres/pgvector); no app-level auth/SSO; Canvas token in macOS Keychain; the device is the security boundary. (PRD v1.6 right-sizing.)
4. **No embeddings in v1.** KB retrieval = intent-scoped pack loading + lexical/structured selection (BM25 / SQLite FTS5 / rubric-ID routing). Semantic/vector search is deferred to Phase 3.
5. **Read-only ingestion.** Docling converts/extracts only; never tag or remediate the source document.
6. **Sidecar pattern for non-JS runtimes.** Both the Ollama model and the Python `docling-serve` run as bundled local HTTP sidecars (attach-if-running / spawn-if-not / health-check / graceful stop). Same lifecycle shape in `src/llm/process.ts` and `src/ingest/process.ts`.
7. **Engineering conventions.** TypeScript ESM (NodeNext), strict tsconfig, `node:test` + `tsx` (no Jest/Vitest), **zero runtime dependencies**, dependency injection everywhere so everything is unit-testable offline. New code should match this.

---

## 4. Repo map (what exists)

```
src/
  llm/          ✅ Local LLM sidecar (Ollama / Gemma 4 12B) — text, vision, JSON, tool-calling
  ingest/       ✅ Docling ingestion sidecar — read-only DOCX/PPTX/XLSX/PDF/image → structured
  orchestrator/ ✅ Tool registry + bounded tool loop + the unconditional output gate
PRD_…md (v1.6)  ✅ Spec
package.json · tsconfig.json · .gitignore
```

### `src/llm/` — local inference (transport only)
Public surface (`src/llm/index.ts`): `createOllamaSidecar`, `OllamaSidecar`, `OllamaClient`, `OllamaProcess`, `Mutex`, `loadLLMConfig`, plus payload helpers and types (`ChatMessage`, `ChatOptions`, `ChatResult`, `ToolDefinition`, `ToolCall`, `LLMConfig`, `MODEL_ROLES`, …).
- Uses Ollama's **native `/api/chat`** internally (not the OpenAI-compat shim) to access `num_ctx`, `keep_alive`, structured `format`, `think`, `images[]`, and tool-calling. The same server still exposes `/v1` for any external tooling.
- `OllamaSidecar`: `start/stop/chat/chatStream/chatJSON/describeImage`. `OllamaProcess`: attach-or-spawn, health via `/api/version`, warm-load via empty `/api/generate`, SIGTERM→SIGKILL stop. `Mutex` serializes calls (single-user).
- Config defaults: baseUrl `http://localhost:11434/v1`, every model role → `gemma4:12b-mlx`, keepAlive `24h`, numCtx 32768, temp 0.3.
- Tests: `config` (6), `payload` (~11, incl. tool mapping), `ndjson` (5), `integration` (4, **gated** behind `RUN_OLLAMA_INTEGRATION=1` + reachability).

### `src/ingest/` — Docling ingestion sidecar
Public surface (`src/ingest/index.ts`): `createDoclingSidecar`, `DoclingSidecar`, `DoclingClient`, `DoclingProcess`, `loadIngestConfig`, payload helpers, types.
- Targets the **verified** `POST /v1/convert/source` API: `file_sources` (base64) / `http_sources`, `to_formats`, `do_ocr`/`force_ocr`; response `document.{md,html,text,json,doctags}_content` → normalized to `ConvertedDocument`.
- `DoclingSidecar`: `convert/convertPath/convertUrl`. `DoclingProcess`: spawns `docling-serve run --host --port` (default 5001), health = any HTTP response.
- Tests: `config` (5), `payload` (5). **No live integration test yet** (TODO — needs `docling-serve` installed).

### `src/orchestrator/` — turn handling, tool dispatch, the gate
Public surface (`src/orchestrator/index.ts`): `Orchestrator`, `OrchestratorError`, `ToolRegistry`, `createCanonicalTools`, `NotImplementedError`, `EngineDeps`, `enforceGate`, gate types.
- `Orchestrator.handleTurn()` — prompt assembly + **bounded** tool loop (`maxToolIterations`, default 5; throws rather than looping forever). Unknown/throwing tools are reported to the model, not fatal.
- `createCanonicalTools(deps)` builds the **8 canonical PRD §15.3 tools** via DI: `audit_html`, `validate_allowlist`, `check_contrast`, `resolve_theme`, `render_template`, `ingest_document`, `describe_image`, `retrieve_kb`. With no injected dep, a tool rejects with `NotImplementedError` (engine TODO). `describe_image`/`ingest_document` can already be wired to the two sidecars **today**.
- `enforceGate(html, deps)` — the real, tested gate logic (badge withholding). Takes `validateAllowlist` + `audit` as injected deps (the engine supplies them later).
- Tests: `registry` (5), `gate` (5), `orchestrator` (5, scripted-runner mock).

---

## 5. What's NOT built (the real work)

| Module (proposed) | Purpose | PRD | Depends on |
|---|---|---|---|
| **`src/engine`** | Deterministic accessibility engine: **allowlist gate** + **contrast math** (pure) and **render-and-scan** (Playwright/Chromium + axe/Pa11y/rulepack, computed contrast, optional WAVE). Supplies `audit_html`, `validate_allowlist`, `check_contrast` and the gate's `audit`/`validateAllowlist`. | §8, Appendix B/K | — (pure parts); Chromium (render parts) |
| **`src/theme`** | ThemeResolver: accessible foregrounds for a brand palette + warnings/variants. Supplies `resolve_theme`. | §15.3 | contrast math (shared w/ engine) |
| **`src/templates`** | The 8 Canvas templates filled from slots + resolved theme. Supplies `render_template`. | §15.3 | theme, allowlist |
| **`src/knowledge`** | Knowledge Packs + **lexical/structured** retrieval (SQLite FTS5 / BM25 / rubric-ID routing; **no embeddings**). Supplies `retrieve_kb`. | §9.2, §13.1 | storage |
| **`src/storage`** | SQLite schema, local file layout, Keychain token. | v1.6 | — (foundation) |
| **`src/canvas`** | Opt-in **read-only** Canvas import (via canvas-lms MCP / REST). | §17 | storage |
| **App shell** | Electron/Tauri over localhost; bundles + code-signs the two sidecars (Ollama + Python docling-serve); maps `TurnResult`+`GateResult` to UI payloads (§19). Packaging is its own track (notarization, sidecar signing). | §19–§22 | all of the above |

---

## 6. Recommended parallel build plan

**Build order is engine-first (PRD §26.3): prove the deterministic engine with no LLM before wiring the model.** These tracks can run concurrently:

- **Track A — Engine core (pure, TDD, START HERE).** `src/engine`: the **allowlist gate** (Canvas Appendix B allowlist + safe repair, surfacing `removedSemantic`) and **WCAG contrast math** (relative luminance + ratio, AA thresholds). Zero deps, fully unit-testable, and it **unblocks** the orchestrator's gate + 3 engine tools. Make `validateAllowlist`/`checkContrast` conform to the existing `GateDeps`/`EngineDeps` signatures in `orchestrator/gate.ts` + `orchestrator/tools.ts`.
- **Track B — Engine render-and-scan.** Playwright/Chromium render + axe-core/Pa11y + rulepack + computed contrast + optional WAVE. Heavier (adds a real runtime dep + browser); produces `audit()` → `IssueSet`. Separable from A behind the same types.
- **Track C — Theme + Templates.** ThemeResolver then the 8 templates; consumes contrast math from A and the allowlist from A.
- **Track D — Knowledge.** Pack format + SQLite FTS5 retrieval. Independent; can start immediately.
- **Track E — Storage foundation.** SQLite + Keychain + local file layout. Independent, foundational (D and others build on it).
- **Track F — App shell + packaging.** Electron/Tauri, sidecar bundling/signing/notarization. Integrates last.
- **Track G — Canvas read-only import.** Opt-in; independent.

**Quickest early win that needs no engine:** wire `describe_image` → `llm.describeImage` and `ingest_document` → `docling.convertPath` in `createCanonicalTools(...)` — both sidecars already exist. (Requires `ollama pull gemma4:12b-mlx` and `pip install docling-serve` to run live.)

**Suggested kickoff:** start **A + D + E** in parallel (all independent, all pure/foundational), then layer B/C, integrate F.

---

## 7. Per-module open TODOs (from the READMEs)

- **llm:** real-model integration runs are gated/skipped — exercise them once `gemma4:12b-mlx` is pulled. Consider a streaming turn helper for the chat UI.
- **ingest:** add a live integration test (needs `docling-serve`); map an `ocr_preset` → Docling options; consider the async convert endpoints for large files.
- **orchestrator:** wire the 5 engine tools to `src/engine`/`src/theme`/`src/templates`/`src/knowledge` as built; prompt assembly from Knowledge Packs (currently a passthrough); streaming turn variant; map `TurnResult`+`GateResult` into the §19 API payloads.

---

## 8. Decision log (the "why", so it isn't relitigated)

- **Ollama over mlx-vlm / vLLM** — company-backed & mature vs single-maintainer; MLX engine serves Gemma 4 12B with vision on Apple Silicon. (vLLM *can* run on Apple Silicon via vllm-metal — that earlier claim was corrected — but Ollama was chosen for robustness/packaging.)
- **Single Gemma 4 12B for everything** — text + vision + audio in one resident model; rejected a separate vision model (memory weight) and LiteRT-LM (its 12B build is text+audio only, 32K cap).
- **Native Ollama `/api/chat` internally** — needed `num_ctx`/`keep_alive`/`format`/`think`/`images`/tools the OpenAI-compat shim omits.
- **Docling + Granite-Docling-258M** — only evaluated tool that natively parses Office Open XML (DOCX/PPTX/XLSX), preserving headings/reading order without a render→OCR round-trip; Granite-Docling (258M, MLX ~631MB) only for hard scanned pages; OcrMac (native Vision) as default OCR. Rejected OpenDataLoader (PDF-only) and Gemma-as-parser.
- **No embeddings v1** — lexical/FTS5 is enough for intent-scoped packs; vector search deferred to Phase 3.
- **Removed Pexels/Unsplash + cloud export** — images are user-supplied only (alt text drafted on-device); exports go to local filesystem → zero external calls by default.

---

## 9. Pointers

- **PRD sections that matter most for the build:** §8 (engine), §9.2 + §13.1 (retrieval), §15 (tools/orchestration), §16 (ingestion), §17 (read-only Canvas), §19–§22 (API/UI/preview), §26.3 (build order), Appendix B (allowlist), Appendix H (env vars), Appendix K (WAVE).
- **Memories** (`~/.claude/projects/-Users-laccd-code-canvas-agent/memory/`): `no-cloud-models-constraint`, `document-ingestion-stack`, `build-status-and-conventions`.
- **Canvas tooling available in-session:** the `canvas-lms` MCP (646 tools incl. `get_canvas_html_allowlist`, `validate_html_accessibility`, `sanitize_html_for_canvas`) — useful as a *reference oracle* when building the engine's allowlist/audit, though the shipped app must run those checks **locally** (no external calls).

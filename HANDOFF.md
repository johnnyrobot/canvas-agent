# Canvas Agent — Session Handoff

**Date:** 2026-06-05 · **Status:** built end-to-end + live-verified; knowledge graph built & audited. Open work is polish + graph corrections, not core build.
**Authoritative spec:** `PRD_Canvas_Course_Design_Accessibility_Assistant.md` (v1.6).
**Read this with the project memories:** `build-status-and-conventions`, `no-cloud-models-constraint`, `document-ingestion-stack` (in `~/.claude/projects/-Users-laccd-code-canvas-agent/memory/`).

> This file replaces an earlier (2026-06-04) handoff that predated the engine + product-layer build. The build state below is current; the memory `build-status-and-conventions` is the fuller record. The Decision Log (§6) is preserved from that earlier handoff.

---

## 1. TL;DR — where we are

Canvas Agent is **built end-to-end and on `main`**: the deterministic accessibility engine, the three-mode product layer (Guidance / Build / Remediate), the intent router, session + brand-kit persistence, the read-only Canvas importer, the streaming Electron app, and the **unconditional server-side output gate**. It was built across parallel agent waves (worktrees under `canvas-agent-trees/`, all merged). **Build + Remediate are live-verified** against real local models through the gate.

This session did **no code changes**. It (a) ran `/graphify update` (no-op — nothing changed since the full build), and (b) **traced and adversarially verified** the two INFERRED knowledge-graph edges on `createAppApi()`. Both verified correct; two small graph-quality corrections are **proposed but not applied** (see §4). That's the main open thread.

**Verified facts (per memory; re-run to confirm — this session did not re-run the suite):**
- `npm run typecheck` → clean (strict TS).
- `npm test` → ~**359 tests / 349 pass / 0 fail / 10 gated-skip** (skips are live Ollama/browser/docling).
- **Zero runtime deps** except `playwright`+`axe-core` (engine-render) and `electron`(+builder) (shell).

---

## 2. How to run / verify

```bash
npm run typecheck            # tsc --noEmit (strict)
npm test                     # offline; src/**/*.test.ts + e2e (mocks/injected deps)
npm run build                # tsc + copy:assets (knowledge-pack JSON + renderer html → dist/)
npm run app                  # build + electron .   (the GUI)

# Live (real sidecars). Models pulled into Ollama; docling in .venv-docling:
PATH=".venv-docling/bin:$PATH" MODEL_TEXT=gemma4:31b MODEL_VISION=qwen3-vl:latest npm run app

# Gated integration tests:
RUN_OLLAMA_INTEGRATION=1 npm test     # also RUN_BROWSER_INTEGRATION=1 / RUN_DOCLING_INTEGRATION=1

# Live GUI drivers (Playwright _electron):
scripts/drive-app.mjs · scripts/drive-remediate.mjs · scripts/check-bridge.mjs · scripts/probe-runtime.mjs
```

**Note `npm test` globs must stay quoted** (`'src/**/*.test.ts'`) or `sh` flattens `**` and silently skips nested tests.

---

## 3. Architecture invariants (DO NOT VIOLATE)

Hard constraints from the PRD + user decisions. Every change must honor them.

1. **No cloud models; no external network calls by default.** All inference is local via Ollama. No Anthropic/OpenAI/hosted API, no cloud key, no telemetry, no cloud export, no image-fetch service (Pexels/Unsplash removed). Only opt-in external touch: the **read-only Canvas import** (GET-only, PRD §17) and the opt-in WAVE engine. See memory `no-cloud-models-constraint`. (`claude` was the dev tool only — never a runtime dependency.)
2. **The output gate is unconditional and server-side.** `src/orchestrator/gate.ts::enforceGate()` runs allowlist + audit on *every* emitted HTML fragment regardless of model output; a residual **blocker withholds the badge** (`A11Y_FAIL_OPEN=false`). Removing a *semantic* element during allowlist repair is itself a blocker. The model never self-certifies. **`createAppApi` is the enforcement locus** — it calls `enforceGate` directly (see §4); the orchestrator does not.
3. **Single-user Apple-Silicon desktop app.** `node:sqlite` + local files (Electron 42 bundles Node 24.15 — works with NO flag); no app-level auth/SSO; Canvas token in macOS Keychain (via `execFile` arg-array, never a shell string); the device is the security boundary.
4. **No embeddings in v1.** KB retrieval = intent-scoped pack loading + lexical/structured selection (FTS5/BM25/rubric-ID routing). Vectors deferred to Phase 3.
5. **Read-only ingestion.** Docling converts/extracts only; never tags or remediates the source.
6. **Sidecar pattern.** Ollama + Python `docling-serve` run as local HTTP sidecars (attach-if-running / spawn-if-not / health / SIGTERM→SIGKILL). Same shape in `src/llm/process.ts` and `src/ingest/process.ts`.
7. **Conventions.** TypeScript ESM (NodeNext), strict tsconfig (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `node:test` + `tsx` (no Jest/Vitest), zero runtime deps, **parameterized SQL only**, dependency injection everywhere for offline tests. Match this in new code.

---

## 4. This session's work — the knowledge graph + the open correction

**Graph:** `graphify-out/` holds a knowledge graph of `src/` (132 files) → **784 nodes / 2,139 edges / 23 communities** (`graph.json`, interactive `graph.html`, `GRAPH_REPORT.md`). Built from AST (711 nodes, deterministic) + a 6-subagent semantic layer (Gemini's API was down → fell back to Claude subagents). `graphify-out/` is **untracked / not gitignored** — decide whether to commit it or add to `.gitignore` (generated artifact, ~1.7 MB).

**Verification done:** the two INFERRED edges touching the runtime keystone `createAppApi()` were traced and put through an adversarial panel (evidence-gatherer + 3 refutation lenses per edge, 8 agents). **Both edges are correct — 0/6 refutations.** Saved Q&A: `graphify-out/memory/query_20260605_060842_*.md`.

**The headline finding:** the AST layer has **zero** `createAppApi → enforceGate` edges (the `enforceGate()` node exists but nothing structural links to it) because the gate calls live inside the nested closures `runStandardTurn`/`runRemediate` that the AST never promoted to nodes. So the two INFERRED semantic edges are the **only** record in the graph of the runtime's most safety-critical relationship (the unconditional gate). Also: the gate *code* lives in the orchestrator package (`orchestrator/gate.ts`) but is *invoked* from the runtime (`app-api.ts`) — `Orchestrator.handleTurn` never calls `enforceGate`; `createAppApi` gates *after* it returns. (Crosses the C0 Orchestrator ↔ C1 Runtime community boundary.)

**PROPOSED graph corrections — NOT yet applied** (next session's decision):

| Edge | Stored | Verdict | Proposed fix |
|------|--------|---------|--------------|
| "Remediate before-after re-audit loop" → `createAppApi()` | `rationale_for` / 0.85 | real, but mislabeled + under-confident | relabel → **`implements`** (direction: `createAppApi` *implements* the loop); bump **0.85 → 0.95** |
| `createAppApi()` → "Unconditional output gate" | `references` / 0.95 | real, correctly calibrated | keep 0.95; optionally tighten `references` → **`calls`/`implements`** |

To apply: hand-edit `graphify-out/graph.json` + regenerate report/html, or (cleaner) re-run extraction so the semantic layer re-derives them. **Caveats to preserve if editing:** Edge-A's loop runs only on the remediate-WITH-`remediateInput` path (`runTurn` dispatch); `issueDiffs` is one-directional (before-keyed, misses post-edit regressions); Edge-B's concept is sourced to `engine/render/README.md` which only mentions the gate in passing (canonical def is `orchestrator/gate.ts:1-12`).

**Other graph threads offered (not started):** why `ChatResult` bridges 6 communities; the 168 weakly-connected nodes (`TURN_VIEW`/`SESSION`/`SESSION_STATE`). Query the existing graph directly with `/graphify query "<question>"` (fast path — no rebuild). Re-run `/graphify update` after any code change to refresh.

---

## 5. Prioritized next tasks

**Canvas Agent (product):**
1. **Drive-test the un-driven panels** (rendered + wired, not yet exercised live): Guidance Q&A, brand-kit save/reload, alignment panel, session persist→reload. Extend the `scripts/drive-*.mjs` pattern.
2. **electron-builder mac packaging** — config present, **not executed**. Needs an Apple Developer cert (signing/notarization) and must bundle `dist/knowledge/packs` + the venv/sidecar binaries. See the 4 GUI/packaging gotchas in memory `build-status-and-conventions` (asset copy, `sandbox:false`, stub-fallback masking "ready", `ensureAppDirs` before `openDatabase`).
3. **Model default nuance:** code keeps the PRD default `gemma4:12b-mlx` (so the "matches PRD Appendix H" test passes); live verification used `gemma4:31b` via `MODEL_TEXT`. Decide whether to change the code default (would need the test updated) — user has not asked to.

**Knowledge graph (this session's thread):**
4. Decide on the §4 edge corrections (apply or leave as honest INFERRED).
5. Decide commit-vs-gitignore for `graphify-out/`.

**Housekeeping:**
6. **Prune the 6 merged worktrees** under `/Users/laccd/code/canvas-agent-trees/` — `w1-canvas-fetch`, `w1-orchestrator-modes`, `w1-runtime-spine`, `w1-storage-sessions`, `w2-app-ipc-streaming`, `w2-app-ui` — all merged to `main`. `git worktree remove <path>` then `git branch -d track/<name>`.

---

## 6. Decision log (the "why", so it isn't relitigated)

- **Ollama over mlx-vlm / vLLM** — company-backed & mature vs single-maintainer; serves Gemma-class models with vision on Apple Silicon. (vLLM can run on Apple Silicon via vllm-metal, but Ollama was chosen for robustness/packaging.)
- **Single resident model for everything** — text + vision in one model; rejected a separate vision model (memory weight) and LiteRT-LM (text+audio only, 32K cap). Code default is `gemma4:12b-mlx` (PRD Appendix H); live runs used `gemma4:31b` + `qwen3-vl` via env.
- **Native Ollama `/api/chat` internally** — needed `num_ctx`/`keep_alive`/`format`/`think`/`images`/tools the OpenAI-compat shim omits.
- **Docling + Granite-Docling-258M** — only evaluated tool that natively parses Office Open XML (DOCX/PPTX/XLSX), preserving headings/reading order without a render→OCR round-trip; Granite-Docling only for hard scanned pages; OcrMac (native Vision) default OCR. Rejected OpenDataLoader (PDF-only) and Gemma-as-parser. See memory `document-ingestion-stack`.
- **No embeddings v1** — lexical/FTS5 is enough for intent-scoped packs; vector search deferred to Phase 3.
- **Removed Pexels/Unsplash + cloud export** — images are user-supplied only (alt text drafted on-device); exports go to the local filesystem → zero external calls by default.
- **Frozen additive contract** — `src/contracts/index.ts` is the cross-track coordination backbone; the product layer extended it additively (`ProductMode`, `RemediateResult`, `Session*`, `BrandKit`, `CanvasPage`, `TurnChunk`/`OnTurnChunk`; `AppApi` grew to 13 methods). Keep additions additive.

---

## 7. Pointers

- **Specs:** `docs/superpowers/specs/2026-06-04-product-layer-design.md` (product layer), `2026-06-04-parallel-agent-build-design.md` (engine build runbook).
- **Memories** (`~/.claude/projects/-Users-laccd-code-canvas-agent/memory/`): `build-status-and-conventions` (fullest build record + the 4 packaging gotchas), `no-cloud-models-constraint`, `document-ingestion-stack`.
- **Graph:** `graphify-out/graph.html` (open in browser), `GRAPH_REPORT.md` (God Nodes / Surprising Connections / Suggested Questions), saved query in `graphify-out/memory/`.
- **Git:** `main` @ `ccaff9f`; product-layer history is the Wave 1/Wave 2 merges + the four live-bug fixes (`69ffd10` sandbox:false, `9b8504c` copy:assets, `20d85ef` ensureAppDirs, `f9ea33c` router split).
- **PRD sections that matter most:** §8 (engine), §9.2 + §13.1 (retrieval), §15 (tools/orchestration), §16 (ingestion), §17 (read-only Canvas), §19–§22 (API/UI/preview), §26.3 (build order), Appendix B (allowlist), Appendix H (env vars), Appendix K (WAVE).
- **Canvas tooling in-session:** the `canvas-lms` MCP (646 tools incl. `get_canvas_html_allowlist`, `validate_html_accessibility`, `sanitize_html_for_canvas`) — useful as a *reference oracle* when evolving the engine's allowlist/audit, though the shipped app runs those checks **locally** (no external calls).

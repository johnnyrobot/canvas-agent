# Canvas Agent — Session Handoff

**Date:** 2026-06-13 · **Status:** built end-to-end + on `main`; the entire code-confirmed deep-review backlog (C1–C15, all §9a auditor follow-ups, the contrast-adjudication feature, and most of the "lower-severity cheap tail") is **fixed and merged**. Open work is a short list of deliberately-deferred, larger items.
**Authoritative spec:** `docs/PRD_Canvas_Course_Design_Accessibility_Assistant.md` (v1.6).
**Live ledger of fixes:** `docs/REVIEW-2026-06-12.md` — §1a is the fix table (start here), §2 the cluster, §9a the auditor review, §10 still-uncovered.
**Read with the project memories** (`~/.claude/projects/-Users-laccd-code-canvas-agent/memory/`): `canvas-agent-critical-bug-cluster` (the live tracker), `canvas-agent-parallel-worktree-hazard` (READ THIS — see §0), `build-status-and-conventions`, `no-cloud-models-constraint`, `document-ingestion-stack`, `a11y-regulatory-competitive-landscape`.

---

## 0. RESUME HERE (2026-06-13)

**Current `main` tip: `3fbc39a`.** Suite: **444 tests / 431 pass / 0 fail / 13 gated-skip**; `tsc --noEmit` clean. Working tree should be clean except the long-standing untracked items (`.claude/`, `.codex/`, `graphify-out/`, `AGENTS.md`, `CLAUDE.md`, `docs/PRD_…`) — never stage those.

⚠️ **CONCURRENT-WORKTREE HAZARD (this bit us repeatedly).** This repo is shared with other sessions/worktrees (`canvas-agent-trees/`, `.claude/worktrees/`) and an autonomous workstream that commits and **moves branch refs** in the shared main working tree under the same author identity. Consequences seen: a branch was force-moved off our commit; `main` advanced between two adjacent git commands; working-tree files (incl. `REVIEW-…md`) were reverted mid-edit. **Rules for tomorrow:**
- **Trust `git log main`, NOT branch names.** Before any merge, run `git rev-parse --short main` and `git merge-base --is-ancestor main <branch>`; re-verify right before the merge.
- Work on a dedicated branch, commit often, and prefer **fast-forward** merges you've just re-verified.
- After `git checkout -b`, confirm the commit's parent is what you expect (`git log --oneline -1 <branch>^`).
- Our integrity work was never lost — but only because commits are durable in git. Don't rely on uncommitted working-tree state.

**Proven workflow for these fixes** (use it again): for each batch, run a background **Workflow** that scopes every candidate against *current* code (line numbers in the review doc are stale) and **adversarially verifies** the fix + RED test, classifying effort; then implement the confirmed/cheap ones **inline with TDD** (RED → watch it fail → minimal GREEN). The adversarial pass has repeatedly caught real subtleties (C13 post-order ordering; the L3 multi-`url()` hole; "router remediateInput-dropped is NOT a bug").

### Still open (deliberately deferred — each is larger than "cheap")
Recommended order is roughly top-to-bottom; **daemon-respawn is the highest-value first target.**

1. **LLM daemon-respawn + mutex-deadlock resilience** (`src/llm/process.ts`, `src/llm/sidecar.ts`, `src/llm/mutex.ts`). The `OllamaProcess` exit handler only nulls `this.child` — after a mid-session daemon crash nothing re-runs `ensureRunning()`, so the LLM stays dead until restart. Separately, `Mutex.acquire` has no timeout/abort, so a leaked lock (abandoned generator) wedges every later call. **Recommended split:** do the respawn supervisor first (lazy re-`ensureRunning()` on the chat path, with backoff + max-restart guard, honoring attach-don't-kill), then optionally the mutex timeout. RED tests sketched in the workflow output.
2. **Conformance-claims-in-prose injection** (`src/runtime/app-api.ts`). The gate guards the badge/HTML, but the model's free `view.text` is surfaced verbatim — a prompt-injected "this page is WCAG 2.2 AA certified" reaches the UI even when the badge is withheld. The right fix is a **data-model change** (conformance expressible only via gate-derived badge data, never trusting prose), not a heuristic scrubber — touches the frozen `TurnView` contract, so it's partly a **product decision**. Flag to the user before building.
3. **RCDATA/RAWTEXT/PLAINTEXT tokenizer modeling** (`src/engine/allowlist.ts`). `textarea/title/noscript/xmp/plaintext` are parsed as normal markup → divergence vs Chromium/Canvas (e.g. `<textarea><b>x</b></textarea>` leaks a live `<b>`). **Latent — neutralized in prod by the sandboxed iframe + CSP + Canvas's own save-time sanitizer**, so it's a fidelity gap, not an escape. Medium effort; stay inside the tokenizer (no regex-on-HTML).
4. **SB1 perf:** reuse one Chromium across a course-wide scan instead of launch-per-fragment (`src/engine/render/playwright-runner.ts`).

(Also latent, guard only if ever wired to a tool: `convertUrl`/`http_sources` SSRF in ingestion — no tool calls it today.)

### What got DONE in the Jun 12–13 arc (all on `main`, all TDD)
- **§2 cluster C1–C15** — streaming-drops-tools (C1), gate under-blocks (C2), stub fabricates badges (C3), ingest lifecycle never starts (C4), spawn crash (C5), ingest path traversal (C6), Canvas token in renderer→Keychain (C7), nav guard (C8), retrieval zero-hits (C9), session fragments dropped (C10), streaming truncation/error swallowed (C11), constant blocker id (C12), recursive-HTML stack-overflow (C13), renderer drops warnings (C14), heading-remap/control-flatten (C15).
- **§9a auditor follow-ups — all closed:** WCAG tag coverage gap; **alpha compositing + gradient/background-image detection** (the parallel **contrast-adjudication** feature, merged); **Canvas-shell parity** (audit + preview/export now share one pure `engine/render/canvas-shell.ts`, so "what you see matches what was audited" holds).
- **Cheap tail + C11 non-streaming sibling:** non-streaming `chat()` truncation/error; raw-text close-tag delimiter (L1); `object/embed` URL scheme-gating (L2); `filterStyle` paren-aware split + every-`url()` scan (L3); Canvas per-GET timeout (L4); router whole-word + verb/noun split (L5); `canvas_imports` provenance UPSERT (L6).

See `docs/REVIEW-2026-06-12.md` §1a for the full fix table with file + test references.

---

## 1. What the app is

Canvas Agent is **built end-to-end and on `main`**: the deterministic accessibility engine (allowlist tokenizer→tree→repair→serialize, Playwright+axe render-and-scan, WCAG contrast math incl. alpha compositing + gradient/image backgrounds), the three-mode product layer (Guidance / Build / Remediate), the intent router, session + brand-kit persistence, the read-only Canvas importer, the streaming Electron app, and the **unconditional server-side output gate**. Build + Remediate are live-verified against real local models through the gate.

---

## 2. How to run / verify

```bash
npm run typecheck            # tsc --noEmit (strict)
npm test                     # offline; src/**/*.test.ts + e2e (mocks/injected deps) → 444/431/0/13
npm run build                # tsc + copy:assets (knowledge-pack JSON + renderer html → dist/)
npm run app                  # build + electron .   (the GUI)

# Gated integration tests (opt-in; need real sidecars/binaries):
RUN_BROWSER_INTEGRATION=1 npm test    # real Chromium audit (6 tests) — RUN THESE when touching engine/render
RUN_OLLAMA_INTEGRATION=1 npm test     # live Ollama   ·  RUN_DOCLING_INTEGRATION=1  for docling

# Run a single file fast:
npx tsx --test src/<path>.test.ts

# Live GUI drivers (Playwright _electron):
scripts/drive-app.mjs · scripts/drive-remediate.mjs · scripts/check-bridge.mjs · scripts/probe-runtime.mjs
```

**`npm test` globs must stay quoted** (`'src/**/*.test.ts'`) or `sh` flattens `**` and silently skips nested tests. The 13 skips are the env-gated live Ollama/browser/docling suites.

After any code change, run `graphify update .` (AST-only, no API cost) to keep `graphify-out/` current. For codebase questions use `graphify query "<q>"` before grepping.

---

## 3. Architecture invariants (DO NOT VIOLATE)

Hard constraints from the PRD + user decisions. Every change must honor them.

1. **No cloud models; no external network calls by default.** All inference is local via Ollama. No Anthropic/OpenAI/hosted API, no cloud key, no telemetry, no cloud export, no image-fetch service. Only opt-in external touch: the **read-only Canvas import** (GET-only, PRD §17) and the opt-in WAVE oracle. See memory `no-cloud-models-constraint`. (`claude` is the dev tool only — never a runtime dependency.)
2. **The output gate is unconditional and server-side.** `src/orchestrator/gate.ts::enforceGate()` runs allowlist + audit on *every* emitted HTML fragment regardless of model output; a residual **blocker withholds the badge** (`A11Y_FAIL_OPEN=false`). Severities `blocker` AND `error` (axe critical+serious) block (C2). Removing a *semantic* element during allowlist repair is itself a blocker, with a **tag-scoped id** `allowlist-removed-semantic:<tag>` (C12). The model never self-certifies. **`createAppApi` is the enforcement locus** — it calls `enforceGate`; the orchestrator does not. (NB §0 open item #2: prose is not yet gated.)
3. **Never auto-certify; never synthesize ARIA/alt text.** AI drafts are labeled unverified; a truncated draft (`done_reason='length'`) must be detectable (C11) and never surfaced as final.
4. **Single-user Apple-Silicon desktop app.** `node:sqlite` + local files; no app-level auth/SSO; **Canvas token in macOS Keychain** (via `execFile` arg-array, never a shell string, never the renderer — C7); the device is the security boundary.
5. **No embeddings in v1.** KB retrieval = intent-scoped pack loading + lexical/structured selection (FTS5 porter-stemmed + BM25 + rubric-ID routing). Vectors deferred to Phase 3.
6. **Read-only ingestion.** Docling converts/extracts only; never tags/remediates the source. Model-supplied file refs are confined to the uploads dir (C6).
7. **Sidecar pattern.** Ollama + Python `docling-serve` run as local HTTP sidecars (attach-if-running / spawn-if-not / health / SIGTERM→SIGKILL), same shape in `src/llm/process.ts` and `src/ingest/process.ts`. (NB §0 open item #1: no respawn after crash yet.)
8. **Conventions.** TypeScript ESM (NodeNext), strict tsconfig (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), `node:test` + `tsx` (no Jest/Vitest), **zero runtime deps** (only `playwright`+`axe-core` in engine-render and `electron`(+builder) in the shell), **parameterized SQL only**, dependency injection everywhere for offline tests. TDD (RED→GREEN) for every change. Match this in new code.

---

## 4. Other open threads (lower priority)

- **electron-builder mac packaging** — config present, not executed. Needs an Apple Developer cert (signing/notarization) and must bundle `dist/knowledge/packs` + the venv/sidecar binaries. See the 4 GUI/packaging gotchas in memory `build-status-and-conventions` (asset copy, `sandbox:false`, honest-degraded fallback, `ensureAppDirs` before `openDatabase`).
- **Drive-test the un-driven panels** (rendered + wired, not yet exercised live): Guidance Q&A, brand-kit save/reload, alignment panel, session persist→reload. Extend the `scripts/drive-*.mjs` pattern.
- **Model default nuance:** code keeps the PRD default `gemma4:12b-mlx` (so the Appendix-H test passes); live verification used `gemma4:31b` via `MODEL_TEXT`. Changing the code default would need the test updated — user hasn't asked.
- **Housekeeping / worktrees:** stale branches from the concurrent contrast work may linger (e.g. a repointed `fix/integrity-cluster-c11-c15` now points at contrast work, not C11–C15). The original Wave-1/2 build worktrees under `canvas-agent-trees/` are all merged and prunable (`git worktree remove` + `git branch -d`) — but **coordinate with the concurrent session first** given §0.
- **graphify graph:** `graphify-out/` is untracked (generated, ~1.7 MB). Decide commit-vs-gitignore. Two proposed-but-unapplied edge corrections on `createAppApi → enforceGate` remain from the Jun 5 session (low priority).

---

## 5. Decision log (the "why", so it isn't relitigated)

- **Ollama over mlx-vlm / vLLM** — company-backed & mature; serves Gemma-class models with vision on Apple Silicon.
- **Single resident model for everything** — text + vision in one model; rejected a separate vision model and LiteRT-LM. Code default `gemma4:12b-mlx` (PRD Appendix H); live runs used `gemma4:31b` + `qwen3-vl` via env.
- **Native Ollama `/api/chat` internally** — needed `num_ctx`/`keep_alive`/`format`/`think`/`images`/tools the OpenAI-compat shim omits. Streaming now also surfaces `tool_calls` (C1) and `done_reason` (C11).
- **Docling + Granite-Docling-258M** — only evaluated tool that natively parses Office Open XML preserving headings/reading order without render→OCR. Rejected OpenDataLoader (PDF-only) and Gemma-as-parser. See memory `document-ingestion-stack`.
- **No embeddings v1** — lexical/FTS5 is enough for intent-scoped packs; vectors deferred.
- **Removed Pexels/Unsplash + cloud export** — images are user-supplied only; exports go to the local filesystem → zero external calls by default.
- **Frozen additive contract** — `src/contracts/index.ts` is the cross-track backbone; extend additively only (`SessionMessage.fragments?`, `ChatResult.doneReason?`, `FragmentVm.warnings`, etc. were all additive).
- **Audit renders the FULL Canvas shell** (§9a) — the audit adopting the richer preview CSS is strictly more faithful (it scans the real link/table/button/blockquote contrast the user sees), and the canonical templates' colors are all AA-passing.

---

## 6. Pointers

- **Live ledger:** `docs/REVIEW-2026-06-12.md` — **§1a fix table is the first thing to read** (every fix → file + test); §2 cluster; §9a auditor; §10 still-uncovered.
- **Specs/plans:** `docs/superpowers/specs/` + `docs/superpowers/plans/` (incl. the contrast-adjudication design/plan); `docs/research/wave/` (WAVE oracle).
- **Memories** (`~/.claude/projects/-Users-laccd-code-canvas-agent/memory/`): `canvas-agent-critical-bug-cluster` (live tracker), `canvas-agent-parallel-worktree-hazard` (the §0 gotcha), `build-status-and-conventions`, `no-cloud-models-constraint`, `document-ingestion-stack`, `a11y-regulatory-competitive-landscape`.
- **Graph:** `graphify-out/graph.html` (browser), `GRAPH_REPORT.md`; query with `graphify query "<q>"`.
- **Git:** `main` @ `3fbc39a`. Recent arc: `68b39e7` (C1,C2,C3,C5,C9,WCAG) · `d3e0478` (C4,C7,C10) · `7954cbb` (C6,C8) · `0c3a42a→9edb92c` (C11–C15) · contrast-adjudication merge `136f9a3` · `9469e2e` (§9a Canvas-shell parity) · `3fbc39a` (C11 non-streaming + cheap tail).
- **PRD sections that matter most:** §8 (engine), §9.2 + §13.1 (retrieval), §15 (tools/orchestration), §16 (ingestion), §17 (read-only Canvas), §19–§22 (API/UI/preview), Appendix B (allowlist), Appendix H (env vars), Appendix K (WAVE/contrast).
- **Canvas tooling:** the `canvas-lms` MCP (incl. `get_canvas_html_allowlist`, `validate_html_accessibility`, `sanitize_html_for_canvas`) is a *reference oracle* when evolving the engine — the shipped app runs those checks **locally**.

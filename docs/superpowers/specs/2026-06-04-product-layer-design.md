# Canvas Agent — Product Layer Design (Modes, Router, Sessions, Preview, Export, Brand-Kit, Alignment Coach)

**Date:** 2026-06-04
**Status:** proposed (awaiting approval)
**Builds on:** the completed engine + 8 tools + runtime + Electron shell (see `build-status-and-conventions` memory and `2026-06-04-parallel-agent-build-design.md`).

## 1. Goal

The engine and the 8 tools exist and are wired, so the model can already audit/build/ingest ad hoc in a generic chat box. This effort builds the **product layer** the PRD describes on top of that toolbox:

- Three **modes** — Guidance / Build / Remediate — plus an **intent router** that picks the mode when the user doesn't.
- A **Remediate flow**: import existing HTML (incl. read-only Canvas page) → audit → model-driven fix → re-audit → before/after diff.
- **Session persistence** (wire the already-present, unused `Database`).
- **Streaming** responses into the UI.
- A **Canvas-fidelity preview** (sandboxed iframe) + **export/copy/show-code** per fragment.
- A **brand-kit editor** (persisted palette → `resolveTheme`, AA-guaranteed).
- An **Alignment Coach** (content → learning objectives / rubric criteria).

## 2. Non-negotiable invariants (every track preserves these)

1. **Output gate is unconditional + server-side.** `enforceGate` re-checks every fragment regardless of mode; a residual blocker withholds the badge (`A11Y_FAIL_OPEN=false`). No mode bypasses it.
2. **No cloud / zero external calls by default.** Local Ollama + Docling only.
3. **Canvas is read-only / GET-only.** Remediate never writes back; the no-write test stays green.
4. **Parameterized SQL only.**
5. **No embeddings in v1** (lexical FTS5/BM25).
6. **Electron security posture:** `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`; the *only* `innerHTML` sink is `gate.html`; all other text via `textContent`; strict CSP.
7. **The 8 canonical model-callable tools stay frozen.** Remediate/Alignment reuse existing tools + orchestration; no new *model-callable* tool is required for v1 (Alignment Coach is the one optional exception — see §4.8).
8. **Additive contract only.** Every new field is optional; every new method is additive; no existing signature breaks.

## 3. Frozen contract additions (`src/contracts/index.ts`)

The lead writes and commits these **first**; all tracks then code against them. (`guidance|build|remediate` are lowercase string-literal unions; `SessionMessage` is decoupled from `llm`'s `ChatMessage`.)

```typescript
// ── Product modes ────────────────────────────────────────────────────────────
/** The three product modes. Omitted on a request ⇒ the intent router decides. */
export type ProductMode = 'guidance' | 'build' | 'remediate';

// ── Remediate ────────────────────────────────────────────────────────────────
export interface RemediateInput {
  /** HTML to remediate (pasted, or fetched read-only from Canvas). */
  sourceHtml: string;
  /** Optional provenance; never used to write back. */
  canvasPageRef?: { courseId: string; pageId: string };
}
export interface IssueFix {
  issue: AuditIssue;          // from gate.ts (re-exported here)
  fixed: boolean;             // resolved in the 'after' pass?
}
export interface RemediateResult {
  before: string;             // original HTML
  after: string;              // gated, repaired HTML
  issueDiffs: IssueFix[];     // per-issue before→after resolution
  gate: GateResult;           // gate result for `after`
}

// ── Sessions (decoupled message shape) ───────────────────────────────────────
export interface SessionMessage { role: 'user' | 'assistant' | 'system' | 'tool'; content: string; }
export interface Session {
  id: string;
  title: string;
  mode: ProductMode;
  createdAt: string;          // ISO 8601 UTC
  updatedAt: string;          // ISO 8601 UTC
}
export interface SessionState { session: Session; messages: SessionMessage[]; }

// ── Brand kit ────────────────────────────────────────────────────────────────
export interface BrandKit {
  id: string;
  name: string;
  palette: { primary: string; secondary: string };
  fonts?: { heading?: string; body?: string; mono?: string };
  createdAt: string;          // ISO 8601 UTC
}

// ── Read-only Canvas page (for Remediate import) ─────────────────────────────
export interface CanvasPage { id: string; title: string; url?: string; updatedAt?: string }

// ── Streaming (in-process callback; IPC bridges it — see §4.4) ───────────────
export type TurnChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: string }
  | { type: 'fragment'; fragment: TurnFragment };
export type OnTurnChunk = (chunk: TurnChunk) => void;

// ── EXTENDED: TurnRequest (all new fields optional) ──────────────────────────
export interface TurnRequest {
  user: string;
  system?: string;
  sessionId?: string;
  mode?: ProductMode;             // explicit override; absent ⇒ router picks
  remediateInput?: RemediateInput;// only honored when resolved mode === 'remediate'
}

// ── EXTENDED: TurnFragment (additive) ────────────────────────────────────────
export interface TurnFragment {
  html: string;
  gate: GateResult;
  remediateResult?: RemediateResult;  // populated only in remediate mode
}

// ── EXTENDED: TurnView (echo the resolved mode) ──────────────────────────────
export interface TurnView {
  text: string;
  fragments: TurnFragment[];
  toolsUsed: string[];
  iterations: number;
  mode?: ProductMode;             // the mode the router/override resolved to
}

// ── EXTENDED: AppApi (additive methods; streaming via optional callback) ──────
export interface AppApi {
  runTurn(req: TurnRequest, onChunk?: OnTurnChunk): Promise<TurnView>;
  importCanvas(config: CanvasConfig, courseId: string): Promise<CanvasImportResult>;
  health(): Promise<RuntimeHealth>;

  // sessions
  listSessions(): Promise<Session[]>;
  loadSession(sessionId: string): Promise<SessionState | null>;
  deleteSession(sessionId: string): Promise<void>;

  // brand kits
  resolveBrandTheme(primary: string, secondary: string): Promise<ThemeResult>; // no LLM; engine resolveTheme
  listBrandKits(): Promise<BrandKit[]>;
  saveBrandKit(kit: Omit<BrandKit, 'id' | 'createdAt'>): Promise<BrandKit>;
  deleteBrandKit(id: string): Promise<void>;

  // read-only Canvas page access (Remediate)
  fetchCanvasPage(config: CanvasConfig, courseId: string, pageId: string): Promise<string>;
  listCanvasPages(config: CanvasConfig, courseId: string): Promise<CanvasPage[]>;
}
```

## 4. Architecture decisions

### 4.1 Intent router
A deterministic, offline classifier `routeIntent(user, override?) → { mode, confidence, reason }`. Heuristics: an explicit `mode` override wins; otherwise keyword/shape signals (e.g. pasted HTML or "fix/accessib/contrast/alt" ⇒ remediate; "create/make/build/template/page" ⇒ build; question forms ⇒ guidance). Optional LLM tie-break is **injected** (so unit tests stay offline) and only consulted on low confidence. Default fallback: `guidance`. Pure function, fully unit-tested.

### 4.2 Mode-aware orchestrator
- `DEFAULT_SYSTEM_PROMPT_BY_MODE[mode]` selects the system prompt.
- Per-mode **tool subsets**: filter `ToolRegistry.definitions()` before passing to `ChatOptions.tools` (e.g. Guidance = read-only/`retrieve_kb`; Build = full set; Remediate = `audit_html` + `validate_allowlist` + `check_contrast`, no `render_template`).
- Per-mode **KB pack scoping** passed to `retrieveKb` (Guidance→`wcag-basics`+`rubric-criteria`; Build→`canvas-templates`; Remediate→`wcag-basics`).
- `mode` flows via `TurnInput.mode` → `ToolContext.mode`. `ToolRegistry` itself stays mode-agnostic (filtering happens at the orchestrator/runtime).

### 4.3 Remediate flow (runtime-level, reuses existing tools)
In `createAppApi.runTurn` when resolved mode is `remediate` and `remediateInput` is present:
1. `enforceGate(sourceHtml)` → capture the **before** issue set.
2. Run a remediate-scoped orchestrator turn: system prompt + the source HTML + the issue list, instructing the model to return corrected `html` (it may call `audit_html`/`validate_allowlist`/`check_contrast`).
3. `enforceGate(modelHtml)` → **after**.
4. Bounded re-audit loop (cap, e.g. 3) while `after.badgeWithheld` and progress is being made.
5. Build `RemediateResult { before, after, issueDiffs, gate }`; `issueDiffs` compares before-issues against after-issues by issue id. Emit as a `TurnFragment.remediateResult`. The gate remains the authority — Remediate never self-certifies.

### 4.4 Streaming across the Electron IPC boundary (the subtle one)
`runTurn(req, onChunk)` is the **in-process** contract (runtime + tests call it directly with a callback). A callback **cannot cross** the contextBridge, so the app track bridges it with an event channel:
- preload generates a `turnId`, registers the renderer's `onChunk` locally, `ipcRenderer.invoke('canvasAgent:runTurn', { req, turnId })`.
- main calls `api.runTurn(req, chunk => event.sender.send('canvasAgent:chunk', { turnId, chunk }))`.
- preload's `ipcRenderer.on('canvasAgent:chunk', …)` routes chunks back to the registered `onChunk`, cleaned up on turn resolution.

The orchestrator emits chunks from `handleTurn`: text deltas from `ChatRunner.chatStream` (already implemented on `OllamaSidecar`; we add `chatStream?` to the `ChatRunner` interface and prefer it when present), `{type:'tool'}` as each tool runs, `{type:'fragment'}` as each fragment clears the gate.

### 4.5 Canvas-fidelity preview (client-side, no new gate)
A renderer-side sandboxed `<iframe sandbox srcdoc=…>` wrapping `fragment.html` (already gate-safe) with a **Canvas-fidelity stylesheet** extracted from the engine's `playwright-runner` `canvasShell` (single source of truth for "what Canvas looks like"). No new AppApi method, no new gate step.

### 4.6 Export / copy / show-code (client-side)
Per fragment: **Copy HTML** (`navigator.clipboard.writeText(fragment.html)`), **Download** (`data:text/html` anchor), **Show code** (toggle a `<pre><code>` with `textContent`). All read `gate.html`. No contract change.

### 4.7 Brand-kit editor
`resolveBrandTheme(primary, secondary)` calls the engine `resolveTheme` directly (no LLM) for instant, AA-guaranteed live preview; the editor renders the resolved role swatches + warnings and a live template preview via the §4.5 iframe. Kits persist via `saveBrandKit`/`listBrandKits` (new `brand_kits` table). Brand colors flow into `render_template`'s optional `theme` exactly as today.

### 4.8 Alignment Coach
Maps content → objectives/rubric using the existing `rubric-criteria` KB pack via `retrieve_kb` (intent-scoped) + an LLM mapping pass; surfaces matched criteria + gaps + confidence. Implemented as a runtime flow surfaced in a renderer panel. *Optional:* a single new model-callable tool `align_content` may be added via the existing factory if the flow reads cleaner as a tool — this is the one sanctioned exception to §2.7, decided during Wave 2.

### 4.9 Sessions
Wire `AppApiOptions.db` (already present, unused). Storage exposes a parameterized DAO over the existing `sessions`/`turns` tables (+ a `mode` column, + `brand_kits`). `runTurn` with a `sessionId` loads prior `messages` into `TurnInput.history`, runs, then persists the turn. `listSessions`/`loadSession`/`deleteSession` back the UI switcher. Runtime maps `llm` `ChatMessage` ↔ contract `SessionMessage`.

## 5. Wave plan (dependency-aware; iTerm2 worktree agents, lead-gated auto-merge)

**Pre-flight (lead, before fan-out):** freeze §3 contract + commit; fix `src/llm/integration.test.ts` token budgets (16/32/64 → ~256–512 or `think:false`) and `src/llm/config.ts` default model off the uninstalled `gemma4:12b-mlx`; confirm suite green under `MODEL_TEXT=gemma4:31b`.

### Wave 1 — Spine (disjoint file ownership; run in parallel)
| Track | Owns | Delivers |
|---|---|---|
| **T1 orchestrator-modes** | `src/orchestrator/**`, `src/llm/types.ts` (add `chatStream?` to `ChatRunner`) | intent router, per-mode prompts + tool subsets + KB scoping, streaming threaded through `handleTurn` (chunk emission) |
| **T2 storage-sessions** | `src/storage/**` | schema (`mode` column, `brand_kits`), parameterized `SessionStore` + `BrandKitStore` DAOs with the signatures in §3 |
| **T3 canvas-fetch** | `src/canvas/**` | GET-only `fetchPageBody(config,courseId,pageId)` + `listPages(config,courseId)`; no-write test stays green |
| **T4 runtime-spine** (integration; merged last) | `src/runtime/**` | wires modes/router + streaming `onChunk` + sessions + `resolveBrandTheme` + canvas page fetch + the Remediate flow into `createAppApi`; implements all new `AppApi` methods against the frozen module signatures |

T4 codes against T1–T3's frozen signatures (the contract discipline that made the last build merge cleanly); the lead merges T1–T3, then T4, then runs the offline suite.

### Wave 2 — Experience (UI; on the real spine)
First step is a **renderer modularization** (lead or first track): split `src/app/renderer/renderer.ts` into a thin shell + `panels/` (`modeBar`, `sessions`, `fragment` [preview+export+show-code], `brandKit`, `alignment`) + `stream.ts`, so the following can own **disjoint files**:
| Track | Owns | Delivers |
|---|---|---|
| **T5 app-shell+stream** | renderer shell, `index.html`, `ipc.ts`, `preload.ts`, `bridge.ts`, `channels.ts` | mode bar, session switcher, the §4.4 streaming event bridge, all new IPC channels |
| **T6 fragment-preview-export** | `panels/fragment.ts` + the shared Canvas-fidelity stylesheet | sandboxed iframe preview + copy/download/show-code |
| **T7 brand-kit** | `panels/brandKit.ts` | color pickers → `resolveBrandTheme` live preview + save/list kits |
| **T8 alignment** | `panels/alignment.ts` + alignment runtime flow | content → objectives/rubric panel |

Exact Wave 2 ownership is finalized at the Wave 1→2 boundary, once the real merged renderer is in hand.

## 6. Verification
- Each track: `node:test` unit coverage, offline, DI-mocked. Lead runs `npm run typecheck` + full `npm test` after each merge.
- Post-Wave-2: full suite green, then **live** drive of all three modes through the on-device stack (`MODEL_TEXT=gemma4:31b MODEL_VISION=qwen3-vl:latest` + `docling-serve` from `.venv-docling`) via computer-use, with screenshots: a Build turn (gated fragment + preview + export), a Remediate turn (before/after diff), a Guidance Q&A, a brand-kit edit, an alignment pass, session save/reload.

## 7. Out of scope (v1)
Writing back to Canvas (read-only forever); embeddings/vector search; multi-user; cloud models; Canvas Content-Migration ZIP export (export is local HTML/copy only); brand palettes beyond two colors.

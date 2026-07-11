# `src/runtime` — the integration keystone (Wave 3)

Wires the finished modules into a runnable turn pipeline and exposes the **frozen
`AppApi`** (`src/contracts`). This is what makes the product actually run: the
Electron app-shell track consumes `AppApi` over IPC and never imports the real
runtime (it builds against a fake `AppApi` in its own tests).

```
TurnRequest ──► routeIntent (guidance | build | remediate)
      │
      ▼
chatRunner (local model)  ── per-mode system prompt + per-mode tools/packs
      │  advertises the mode's canonical tools
      ▼
Orchestrator.handleTurn ──► retrieve_kb grounding ──► bounded tool loop
      │  (onEvent → onChunk: text / tool / fragment)        │
      │  real tools (createEngineDeps):                     │
      │  audit_html · validate_allowlist · check_contrast   │
      │  resolve_theme · render_template · retrieve_kb      │
      │  describe_image · ingest_document                   │
      ▼                                                     ▼
emitted HTML fragments ───────► enforceGate (allowlist + audit) ──► TurnView
```

The product layer adds **mode routing**, **streaming**, the **Remediate** repair
flow, **session persistence**, **brand-kit theme resolution**, and **read-only
Canvas page access** — all on top of the same unconditional gate.

## Layout

| File | Responsibility |
|---|---|
| `deps.ts` | `createEngineDeps(opts)` — adapt the REAL modules onto the orchestrator's `EngineDeps` |
| `app-api.ts` | `createAppApi(opts): AppApi` — the turn pipeline + gate + importer + health |
| `index.ts` | Public surface (`createAppApi`, `createEngineDeps`, re-exported contract types) |
| `*.test.ts` | Offline unit tests (scripted runner, fake sidecars, real engine/theme/templates/knowledge/gate) |

The end-to-end tests live in **`/e2e`** (a sibling of `src`, intentionally
outside the `src/**/*.test.ts` unit glob) — see [Testing](#testing).

## `AppApi` (the output contract)

```ts
import { createAppApi } from './src/runtime/index.js';

const app = createAppApi(); // defaults: real model + sidecars + engine + gate + on-device SQLite

const view = await app.runTurn({ user: 'Build a Week 1 module overview page.' });
// → { text, fragments: [{ html, gate }], toolsUsed, iterations, mode }

// Streaming (in-process): chunks arrive as text / tool / fragment events.
await app.runTurn({ user: 'Make a syllabus page.' }, (chunk) => render(chunk));

// Sessions persist each turn; pass the id to continue the transcript.
const session = await app.createSession({ title: 'Bio 101', mode: 'build' });
await app.runTurn({ user: 'Outline week 1', sessionId: session.id });

// Remediate (repair user-supplied HTML; Canvas stays GET-only).
const fixed = await app.runTurn({
  user: 'Fix this page', mode: 'remediate',
  remediateInput: { sourceHtml: '<p style="color:#ccc">low contrast</p>' },
});
// fixed.fragments[0].remediateResult → { before, after, issueDiffs, gate }

const theme   = await app.resolveBrandTheme('#0a0a0a', '#ffffff');     // pure WCAG math, no LLM
const summary = await app.importCanvas({ baseUrl, token }, courseId);  // read-only
const health  = await app.health();                                   // { llm, ingest }
```

### `runTurn(req, onChunk?)`
1. **Mode routing.** `routeIntent(req.user, req.mode)` resolves the
   `ProductMode` (`guidance | build | remediate`); an explicit `req.mode` wins.
   The resolved `mode` is echoed in the `TurnView` and drives the per-mode system
   prompt (`systemPromptForMode`), the advertised tool set, and the KB packs.
   The base prompt is `req.system ?? opts.systemPrompt ?? systemPromptForMode(mode)`.
2. **History.** When `req.sessionId` is set, the session transcript is loaded and
   mapped (`SessionMessage[]` → `ChatMessage[]`) into the turn's `history`.
3. **Streaming.** When `onChunk` is supplied, the orchestrator's `onEvent`
   (`{type:'text'}` / `{type:'tool'}`) is forwarded as `TurnChunk`s; each gated
   fragment is emitted as `{type:'fragment', fragment}`.
4. **Emitted-fragment rule** (documented + gated): an HTML fragment is
   - any **tool result** carrying a string `html` field (`render_template`,
     `validate_allowlist`), and
   - any ` ```html ` fenced block in the model's final text.
   Each fragment runs through `enforceGate(html, { validateAllowlist, audit })`.
   A residual **blocker withholds the badge** (`badgeWithheld === true`,
   `passedChecks === false`) — the model is never trusted to self-certify
   (PRD §8.6/§15.7). **No mode bypasses the gate.** `fragment.html` is the
   allowlist-gated (safe-to-render) HTML.
5. **Persistence.** With `req.sessionId`, the `{user, assistant}` pair is appended
   to the transcript after the turn.
6. Returns a `TurnView`: `{ text, fragments, toolsUsed, iterations, mode }`.

### Remediate flow (`mode === 'remediate'` + `req.remediateInput`)
1. `before = enforceGate(sourceHtml)` captures the source's conformance issues.
2. A remediate orchestrator turn is run with the source HTML + before-issues; the
   model's emitted HTML is taken and `after = enforceGate(modelHtml)`.
3. A **bounded re-audit loop** (max 3) re-runs while the badge is still withheld
   and each pass improves (clears the badge, or strictly reduces the issue count).
4. The single emitted `TurnFragment` carries a `RemediateResult`
   `{ before, after, issueDiffs, gate }` — `issueDiffs` compares before vs after
   by `AuditIssue.id` (`fixed = present-before && absent-after`). **Canvas is
   never written to** — Remediate only ever reads (GET-only page fetch).

### Sessions / brand kits / Canvas pages
- `createSession` / `listSessions` / `loadSession` / `deleteSession` — storage
  `SessionStore` passthrough (the on-device DB is opened + `migrate()`d lazily).
- `resolveBrandTheme(primary, secondary)` — the real `resolveTheme` (engine WCAG
  math; **no LLM**). `listBrandKits` / `saveBrandKit` / `deleteBrandKit` —
  `BrandKitStore` passthrough.
- `fetchCanvasPage` / `listCanvasPages` — the read-only canvas page readers
  (`fetchPageBody` / `listPages`); GET-only, never mutating.

### `health`
Best-effort sidecar reachability (`{ llm, ingest }`). Never throws — an
unreachable or erroring sidecar reports `false`.

## Dependency injection (offline by construction)

Everything is injectable so `npm test` stays fully offline, but the **real**
engine (allowlist + contrast), theme, templates, knowledge, and gate are always
exercised:

| `AppApiOptions` | Default | Test override |
|---|---|---|
| `chatRunner` | real Ollama sidecar | scripted `ChatRunner` |
| `llm` | real Ollama sidecar | fake `{ describeImage, isHealthy }` |
| `ingest` | real Docling sidecar | fake `{ convertPath, isHealthy }` |
| `retriever` | bundled Knowledge Packs | scripted `KbRetriever` |
| `audit` | real Chromium render-and-scan | `createAuditor(fakeScanRunner)` (real mapping, no browser) |
| `gate` | `{ validateAllowlist, audit }` | marker/issue-counting `GateDeps` fake |
| `importer` | real `importCourse` | fake / `createImporter({ fetch })` |
| `db` | on-device SQLite (lazy `openDatabase` + `migrate`) | `openDatabase(':memory:')` + `migrate` |
| `sessionStore` / `brandKitStore` | built lazily from `db` | injected fake store |
| `resolveTheme` | real `resolveTheme` (no LLM) | injected resolver |
| `fetchPageBody` / `listPages` | real read-only canvas readers | injected fakes / spies |

`createEngineDeps` adapts each module's real signature (e.g. wraps the sync
`checkContrast` as async, validates the `render_template` `type` against the 8
`TemplateType`s, maps `describe_image` → the LLM sidecar, `ingest_document` →
Docling `convertPath`).

## Model selection (no cloud; local Ollama)

The product runs a single on-device model. `src/llm` defaults to
`gemma4:12b-mlx`; the runtime never edits `src/llm`, it steers selection through
the existing env-override mechanism (`src/llm/config.ts`): `runtimeLlmEnv()`
sets `MODEL_TEXT` (which every role falls back to) to `RUNTIME_DEFAULT_MODEL`
unless `MODEL_TEXT` is already set.

`RUNTIME_DEFAULT_MODEL` is **`gemma4:e2b`** (~7 GB resident): sized for the
machines the app ships to, not for the dev box. It replaced `gemma4:31b`
(~20 GB), which excluded most target hardware.

The quality trade is deliberate and bounded. e2b is **pass-biased** on unaided
WCAG judgment — on a 13-case unambiguous probe it scored 8/13, and *every* miss
was a false pass (it cleared an `h1`→`h4` skip, a header-less data table,
"click here" link text, and 2.85:1 contrast). JSON validity was 13/13, so the
`format` constraint holds; it is the judgment that does not. This is safe only
because the model is **not** the detector: axe-core finds issues
deterministically and the gate re-scans every proposed fix. The surfaces where
the model *is* the judge — contrast adjudication and alt-text — are the ones
moving to task-tuned adapters.

```bash
MODEL_TEXT=gemma4:31b-mlx   # opt in to the heavy model (needs ~20 GB free RAM)
```

## Testing

```bash
npm run typecheck                       # tsc --noEmit (strict) — covers src/
npm test                                # offline unit tests (src/**/*.test.ts)
npx tsx --test 'e2e/**/*.test.ts'       # offline e2e + (skipped) live paths
```

- **`e2e/full-turn.test.ts`** — a complete offline turn (scripted model → real
  tools → real gate): asserts a fragment with `gate.conformance.passedChecks`
  true and allowlist-clean HTML, plus a deliberately bad fragment that withholds
  the badge.
- **`e2e/live.test.ts`** — gated, **skipped by default**. Drives the REAL
  sidecars through `AppApi`:
  ```bash
  RUN_OLLAMA_INTEGRATION=1  npx tsx --test 'e2e/**/*.test.ts'   # real Gemma turn + LLM health
  RUN_DOCLING_INTEGRATION=1 npx tsx --test 'e2e/**/*.test.ts'   # real Docling reachability
  ```

> The `e2e/` directory sits outside the package's `src/**/*.test.ts` test glob
> (and `tsconfig` `include`), so `npm test` does not collect it. The
> `src/runtime/*.test.ts` suite already covers the full turn pipeline and is the
> `npm test` gate; the `e2e/` tests are run with the commands above.

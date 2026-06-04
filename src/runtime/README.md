# `src/runtime` — the integration keystone (Wave 3)

Wires the finished modules into a runnable turn pipeline and exposes the **frozen
`AppApi`** (`src/contracts`). This is what makes the product actually run: the
Electron app-shell track consumes `AppApi` over IPC and never imports the real
runtime (it builds against a fake `AppApi` in its own tests).

```
chatRunner (local model)
      │  advertises 8 canonical tools
      ▼
Orchestrator.handleTurn ──► retrieve_kb grounding ──► bounded tool loop
      │                                                     │
      │  real tools (createEngineDeps):                     │
      │  audit_html · validate_allowlist · check_contrast   │
      │  resolve_theme · render_template · retrieve_kb      │
      │  describe_image · ingest_document                   │
      ▼                                                     ▼
emitted HTML fragments ───────► enforceGate (allowlist + audit) ──► TurnView
```

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

const app = createAppApi(); // defaults: real model + sidecars + engine + gate

const view = await app.runTurn({ user: 'Build a Week 1 module overview page.' });
// → { text, fragments: [{ html, gate }], toolsUsed, iterations }

const summary = await app.importCanvas({ baseUrl, token }, courseId); // read-only
const health  = await app.health();                                   // { llm, ingest }
```

### `runTurn`
1. Builds the canonical tools from `createEngineDeps` and runs
   `Orchestrator.handleTurn`. The orchestrator **grounds the system prompt** with
   the top Knowledge-Pack citations for the user message (PRD §13.1), prepended
   above the hard rules (`DEFAULT_SYSTEM_PROMPT`).
2. **Emitted-fragment rule** (documented + gated): an HTML fragment is
   - any **tool result** carrying a string `html` field (`render_template`,
     `validate_allowlist`), and
   - any ` ```html ` fenced block in the model's final text.
   Each fragment runs through `enforceGate(html, { validateAllowlist, audit })`.
   A residual **blocker withholds the badge** (`badgeWithheld === true`,
   `passedChecks === false`) — the model is never trusted to self-certify
   (PRD §8.6/§15.7). `fragment.html` is the allowlist-gated (safe-to-render) HTML.
3. Returns a `TurnView`: `{ text, fragments, toolsUsed, iterations }` (`toolsUsed`
   is the de-duplicated set of canonical tool names the model invoked).

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
| `gate` | `{ validateAllowlist, audit }` | — |
| `importer` | real `importCourse` | fake / `createImporter({ fetch })` |

`createEngineDeps` adapts each module's real signature (e.g. wraps the sync
`checkContrast` as async, validates the `render_template` `type` against the 8
`TemplateType`s, maps `describe_image` → the LLM sidecar, `ingest_document` →
Docling `convertPath`).

## Model selection (no cloud; local Ollama)

The product runs a single on-device model. `src/llm` defaults to
`gemma4:12b-mlx`, which is **NOT installed on this machine** — `gemma4:31b` and
`gemma4:e2b` **are**. The runtime never edits `src/llm`; it steers selection
through the existing env-override mechanism (`src/llm/config.ts`):
`runtimeLlmEnv()` sets `MODEL_TEXT` (which every role falls back to) to
`RUNTIME_DEFAULT_MODEL` (`gemma4:31b`) unless `MODEL_TEXT` is already set.

```bash
MODEL_TEXT=gemma4:e2b   # pick another installed local tag
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

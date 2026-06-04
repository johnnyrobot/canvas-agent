# engine-render — deterministic render-and-scan accessibility audit (PRD §8)

Implements the frozen `Auditor` port from `src/contracts`:

```ts
export type Auditor = (html: string) => Promise<IssueSet>;
```

`audit(html)` renders an HTML fragment in headless Chromium inside a Canvas-like
shell, runs **axe-core** against the rendered DOM, runs a **computed-contrast**
pass over visible text, and returns an `IssueSet` of `AuditIssue`s in the WAVE
six-category vocabulary (Appendix K). It is consumed by the orchestrator's
unconditional output gate (`enforceGate` → `audit(html)` in
`src/orchestrator/gate.ts`).

## Public surface (`src/engine/render/index.ts`)

| Export | What |
| --- | --- |
| `audit: Auditor` | Production audit (Chromium + axe-core + computed contrast). |
| `createAuditor(runner, options?)` | The **pure mapping core** (DI seam; this is what the unit tests drive). |
| `playwrightRunner` / `createPlaywrightRunner(opts?)` | The real headless-Chromium `ScanRunner`. |
| `severityForImpact`, `semanticCategory`, types | Mapping helpers + the local axe/scan type surface. |

`audit` launches a browser **only when called**. `playwright`/`axe-core` are
loaded via dynamic `import()` *inside* `run()`, so importing this module (or
wiring `audit`) never touches a browser.

## Architecture (so tests stay offline)

```
audit(html) = createAuditor(playwrightRunner)
                   │                  │
       pure mapping (offline)   ScanRunner (Chromium) — injected
```

- **`ScanRunner`** (`types.ts`): `run(html) → { axe, textPairs }`. The injection
  seam. Production = `playwrightRunner`; unit tests = a fake returning canned data.
- **`createAuditor(runner)`** (`auditor.ts`): pure axe-results + contrast-pairs →
  `IssueSet`. **No browser, no network.** This is the bulk of the test coverage.
- **`playwrightRunner`** (`playwright-runner.ts`): launches Chromium, injects the
  fragment into the Canvas-like shell, injects `axe.source`, runs axe at the
  WCAG A/AA tags, and extracts computed `{fg,bg,size}` text pairs.

## Mapping tables

### Severity — from axe `impact` (FROZEN; AGENT_BRIEF / Appendix K)

| axe impact | `AuditIssue.severity` |
| --- | --- |
| `critical` | `blocker` |
| `serious` | `error` |
| `moderate` | `warning` |
| `minor` | `advisory` |
| (null / absent on a violation) | `error` (documented default — a definite failure, never auto-blocking) |
| any **incomplete** / needs-review result | `alert` (regardless of impact) |
| computed-contrast AA failure | `blocker` by default (Appendix K.1 Contrast Error withholds the badge); override via `contrastFailSeverity` |
| computed-contrast uncomputable pair | `alert` (gradient/transparency → manual review, Appendix K.5) |

### Category — WAVE six-category vocabulary, from the rule id (Appendix K.1)

| Rule pattern | `AuditIssue.category` |
| --- | --- |
| `color-contrast`, `color-contrast-enhanced`, `*color-contrast*` | `contrast` |
| `aria-*` (e.g. `aria-required-children`, `aria-valid-attr-value`) | `aria` |
| `heading-order`, `region`, `landmark-*`, `list`/`listitem`/`dl*`, `bypass`, data-table structure (`td-headers-attr`, `th-has-data-cells`, `scope-attr-valid`, …) | `structure` |
| any other **violation** (e.g. `image-alt`, `label`, `link-name`, `document-title`) | `error` |
| any other **incomplete** | `alert` |

Per-finding fields: `id` = axe rule id (computed-contrast findings use `contrast`);
`message` = axe `description` (→ `help` → id fallback), or a ratio-bearing
sentence for contrast findings.

> **Note (documented divergence).** Per AGENT_BRIEF, axe `aria-*` results map to
> the `aria` category. Appendix K technically files broken-ARIA-reference *errors*
> under WAVE *Error*; we follow the brief's simpler rule. This only affects
> reporting buckets — the gate's blocking decision is driven by **severity**
> (impact), which is unaffected.

## Computed-contrast pass (§8.3, Appendix K.5)

For each visible text run the runner resolves the computed foreground and the
effective background (first ancestor with a non-transparent `background-color`,
defaulting to the shell's white). `createAuditor` feeds each pair to engine-core's
`checkContrast` (`../index.js`). A pair that fails WCAG AA at its size class
becomes a blocking `contrast` issue; a pair whose colors can't be parsed
(`transparent`, gradients) becomes a needs-review `alert` — never a silent pass.

Render parameters follow Appendix K.5: viewport **1200px**
(`RENDER_VIEWPORT_WIDTH`), settle delay **1000ms** (`RENDER_SETTLE_DELAY_MS`),
animations disabled for determinism.

## Tests

- `mapping.test.ts`, `auditor.test.ts` — **offline**, browser-free; a fake
  `ScanRunner` drives the full axe→IssueSet + contrast mapping (impact→severity,
  incomplete→alert, category mapping, ratio-driven contrast, uncomputable→alert,
  clean→`{issues:[]}`).
- `integration.test.ts` — a single **env-gated** real-Chromium test
  (`RUN_BROWSER_INTEGRATION=1`), `test.skip`-ped by default so the suite is
  offline with **no browser download** (mirrors the gated live-Ollama tests in
  `src/llm/integration.test.ts`).

Run the offline unit tests + see the gated tests skipped:

```sh
npx tsx --test src/engine/render/*.test.ts
```

Run the real-browser path (one-time binary install):

```sh
npx playwright install chromium
RUN_BROWSER_INTEGRATION=1 npx tsx --test src/engine/render/integration.test.ts
```

### ⚠️ Heads-up for the lead: test discovery depth

This track's tests live **two** directories deep (`src/engine/render/*.test.ts`).
The root `npm test` script is `tsx --test src/**/*.test.ts`, and npm runs it under
`/bin/sh`, where `**` is **not** recursive (no `globstar`) — so the shell expands
the glob to **one-level-deep** files only and these tests are **silently not
collected** by `npm test`. (`npm run typecheck` *does* cover them — `tsc` globs
recursively.) Verified: a probe test placed here did not run under `npm test`.

Per the track contract I did **not** edit `package.json`. To include these in
`npm test`, the lead can either widen the script to `src/**/**/*.test.ts`, pass a
recursive directory (`tsx --test --test-name-pattern ... src`), or run npm with a
`globstar`-enabled shell (`npm config set script-shell bash` + `shopt -s globstar`).
Until then, run this track's tests directly with the commands above. All 21 unit
tests + 3 gated browser tests pass.

## Dependencies

This track is the sanctioned exception to the repo's zero-deps rule: it adds
`playwright` and `axe-core` (and nothing else). The Chromium binary is **not**
downloaded by `npm install` here (kept entirely behind the env-gated test).

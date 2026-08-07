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
| `audit: Auditor` | **One-shot** production audit — launch, scan once, close. |
| `createAuditor(runner, options?)` | The **pure mapping core** (DI seam; this is what the unit tests drive). |
| `CHECKS` / `Check` | The check registry — **add a check here** (`checks.ts`). |
| `createPlaywrightRunner(opts?)` | The real headless-Chromium runner. **Owns a browser — dispose it.** |
| `severityForImpact`, `semanticCategory`, types | Mapping helpers + the local axe/scan type surface. |

`audit` launches a browser **only when called**. `playwright`/`axe-core` are
loaded via dynamic `import()` *inside* `run()`, so importing this module (or
wiring `audit`) never touches a browser.

## Browser lifetime (ADR-0005)

A runner from `createPlaywrightRunner()` holds **one** Chromium for its own
lifetime: launched lazily on the first `run()`, reused by every later `run()`,
released by `dispose()`. Construct one **per turn** and dispose it in a
`finally` — a remediate turn scans up to five times (source gate, first repair,
up to three re-audits) and those five scans used to be five launches.

There is deliberately **no module-level runner**. One would hold a Chromium
process nobody closes: the app has no shutdown path to hang a teardown off, so
a process-wide instance is a leak, not a cache. `audit` therefore constructs and
disposes its own runner per call — right for a single audit (the build gate),
wrong for a loop.

`ScanRunner` stays a **single method** on purpose. `dispose()` lives on the
wider `DisposableScanRunner`, returned only by the factory that actually
allocates something; putting it on `ScanRunner` would force every injected test
fake to grow a lifecycle it does not have.

## Architecture (so tests stay offline)

```
audit(html) = createAuditor(createPlaywrightRunner())   ← one-shot; disposed after
                   │                  │
       pure mapping (offline)   ScanRunner (Chromium) — injected

per turn:   runner = createPlaywrightRunner()   ← ONE browser…
            createAuditor(runner)(html) × 5     ← …reused by every scan
            runner.dispose()                    ← …closed in a finally
```

- **`ScanRunner`** (`types.ts`): `run(html) → { axe, textRuns }`. The injection
  seam. Production = `createPlaywrightRunner()`; unit tests = a fake returning canned data.
  Each `TextRun` carries a classified `ResolvedBackground` (`layers`, `gradient`,
  `image` with sampled swatches, or `unresolvable`).
- **`createAuditor(runner)`** (`auditor.ts`): scan once, then run every
  registered check over the result and concatenate their issues. **No browser,
  no network.** It contains no rule logic of its own any more — just the loop.
- **`createPlaywrightRunner()`** (`playwright-runner.ts`): launches Chromium, injects the
  fragment into the Canvas-like shell, injects `axe.source`, runs axe at the
  WCAG A/AA tags, and for each visible text run resolves the foreground color and
  classifies the background into a `ResolvedBackground` discriminated union
  (`layers` | `gradient` | `image` | `unresolvable`).

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

For each visible text run the runner resolves the computed foreground and
classifies the background into a `ResolvedBackground` discriminated union: a solid
`layers` stack (top→bottom CSS colors composited down to an opaque base, defaulting
to the shell's white), a raw `gradient` css string, an `image` (the run's box is
screenshotted, the PNG decoded, and the worst-case opaque background pixels sampled
into rgb swatches), or `unresolvable` (CSS/backdrop filters and conic gradients are
deferred). `createAuditor` feeds each run to engine-core's `checkContrast`
(`../index.js`). A run that fails WCAG AA at its size class becomes a blocking
`contrast` issue (image-sampled runs are an estimate → a `warning`); an
`unresolvable` run becomes a needs-review `alert` — never a silent pass.

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

## Dependencies

This track is the sanctioned exception to the repo's zero-deps rule: it adds
`playwright` and `axe-core` (and nothing else). The Chromium binary is **not**
downloaded by `npm install` here (kept entirely behind the env-gated test).

## Adding an accessibility check (ADR-0003)

Checks are registered in **one** place. Adding one used to mean editing seven
files, because `auditor.ts` hardcoded a numbered pass per rule.

1. Write the rule as a `Check` — `(scan: ScanResult, options) => AuditIssue[]`.
   Pure and synchronous: all the I/O already happened in the `ScanRunner`.
2. Add it to `CHECKS` in `checks.ts`. That is the whole registration.
3. If it needs page data nobody collects yet, add the field to `ScanResult` as
   **optional** and extract it in `playwright-runner.ts`.

Two rules make this cheap, and both are deliberate:

- **A check gets the WHOLE `ScanResult`.** There is no per-check declaration of
  required data, and so no plumbing to extend when a check wants more. The
  declared-requirements alternative was rejected as machinery sized for a rule
  count that doesn't exist — there are four checks.
- **New `ScanResult` fields are OPTIONAL.** That is what stops every existing
  fake fixture from breaking when the next check needs new data. `images` is
  optional for this reason too, retroactively — a rule with one permanent
  exception is one people stop believing.

What a registry does **not** remove: step 3. When a check needs data the runner
doesn't gather, you still write the browser-side extraction. The win is roughly
four of the seven files, not seven.
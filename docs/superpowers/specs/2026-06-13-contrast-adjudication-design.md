# Design — Contrast adjudication for variable backgrounds ("beat WAVE")

**Date:** 2026-06-13
**Status:** Approved design → ready for implementation plan
**Related research:** `docs/research/wave-equivalent-accessibility-engine.md` (+ raw WAVE artifacts in `docs/research/wave/`)
**Owning track:** engine-render (`src/engine/render/`) + engine-core (`src/engine/contrast.ts`)

---

## 1. Context & goal

`canvas-agent` already has a complete, PRD-driven render-and-scan accessibility auditor:

- `src/engine/render/playwright-runner.ts` — headless Chromium + Canvas shell + **axe-core** (WCAG 2.0/2.1/2.2 A+AA) → `violations` + `incomplete` + computed text/background color pairs.
- `src/engine/render/auditor.ts` — maps axe violations → severity/category, incompletes → `alert`, and runs each text pair through `checkContrast`.
- `src/engine/contrast.ts` — full WCAG 2.2 contrast math + CSS color parsing.
- `src/engine/render/mapping.ts` — axe impact → severity + rule id → WAVE six-category vocabulary.
- `src/orchestrator/gate.ts` — allowlist + audit → badge-withholding conformance.

Empirical research (probing the live WAVE API with its docs API) established that **WAVE's contrast detection is the plain WCAG 2.x relative-luminance ratio** — verified by reproducing WAVE's reported ratios to the rounding digit. WAVE's quality is precision/conservatism, not algorithm: it **explicitly skips** text over CSS gradients, transparency, filters, and background-images. axe-core does the same (returns `incomplete`). **Today, `canvas-agent` matches that behavior** — when `checkContrast` can't resolve a pair (gradient/transparency), the auditor routes it to a needs-review `alert`.

**Goal of this feature:** stop punting. Adjudicate worst-case contrast over **gradients, semi-transparent overlays, and background images** — the cases WAVE/axe skip — turning WAVE's documented blind spots into real, evidence-backed findings. This is the "as good as or better than WAVE" differentiator, on-device, in the rendered DOM.

### Decisions locked with stakeholder

- **Primary deliverable:** beat WAVE on contrast (not full WAVE-report inventory parity — that is a separate, later spec).
- **Coverage:** declarative (gradients + overlays) **and** raster (background images).
- **Runtime:** 100% on-device; no runtime cloud. WAVE is a dev-time oracle only.
- **Architecture:** Approach A — browser does **capture only**; a **pure, deterministic core** does all contrast math (preserves the existing pure-core + injected-fake-runner test pattern).
- **Severity by certainty:** deterministic fails (gradient/overlay) block; fuzzy raster estimates warn (configurable).
- **Dependencies:** no new runtime deps — vendor a minimal PNG decoder on `node:zlib`.

### Non-goals (explicitly out of scope here)

- Full WAVE-style report (the `feature` positives inventory, `structure` inventory, WAVE's ~42 heuristic `alert` items). Separate spec.
- APCA / WCAG-3 perceptual contrast (blocked on licensing per research; later, gated).
- Any change to the frozen cross-track contracts. `Auditor = (html) => Promise<IssueSet>` and `ContrastChecker`/`ContrastResult` shapes are **unchanged**.

---

## 2. Architecture & data flow

```
playwright-runner.ts  (browser: CAPTURE ONLY)
   │  in-page extractor classifies each visible text run's background
   │  → returns TextRun[] (JSON-serializable) incl. clip rects for image runs
   │  → Node side: for image runs, page.screenshot({ clip }) → PNG buffer
   ▼
render/png.ts          (pure, node:zlib)   decode PNG → { width, height, rgba }
render/sample.ts       (pure)              pixels + fg → worst-case bg swatches
render/run-contrast.ts (pure)              TextRun → AuditIssue | null  (all bg kinds)
   │      reuses engine/contrast.ts (checkContrast + new gradient/alpha helpers)
   ▼
auditor.ts             (pure)              [3] contrast loop now calls run-contrast
   ▼   IssueSet → orchestrator/gate.ts (UNCHANGED)
scripts/wave-oracle.ts (dev-only)          local engine vs live WAVE API diff
```

Only `playwright-runner.ts` touches a browser (already env-gated). Everything else is pure and unit-tested offline with hand-built fixtures.

### File changes

| File | Change |
|---|---|
| `src/engine/render/types.ts` | Replace `TextColorPair` with `TextRun` + `ResolvedBackground` union; `ScanResult.textPairs` → `textRuns`. (Local types — not frozen.) |
| `src/engine/render/playwright-runner.ts` | Extend in-page extractor to classify background kind (layers/gradient/image/unresolvable) and emit clip rects; Node-side screenshot+decode+sample for image runs. |
| `src/engine/render/png.ts` *(new)* | Vendored minimal PNG decoder (`node:zlib`). |
| `src/engine/render/sample.ts` *(new)* | Pure worst-case background-swatch extraction from decoded pixels + fg. |
| `src/engine/render/run-contrast.ts` *(new)* | Pure adjudicator: `TextRun` → `AuditIssue \| null` across all background kinds. |
| `src/engine/render/auditor.ts` | `[3]` contrast loop calls `run-contrast`; add `imageContrastSeverity` option. |
| `src/engine/contrast.ts` | Precision fix (compare raw ratio); export gradient-stop parse + alpha-composite helpers. |
| `scripts/wave-oracle.ts` *(new, dev-only)* | Local-vs-WAVE diff harness. |
| `*.test.ts` for each | New/updated pure tests + extended fake-runner auditor tests + env-gated integration. |

---

## 3. Data contract (`render/types.ts`, local — safe to change)

```ts
export type ResolvedBackground =
  | { kind: 'layers';  layers: string[] }    // top→bottom CSS colors down to an opaque base (white fallback)
  | { kind: 'gradient'; css: string }        // raw computed gradient string; parsed by the pure adjudicator
  | { kind: 'image';   swatches: string[] }  // worst-case opaque bg samples under the run (from screenshot)
  | { kind: 'unresolvable'; reason: string };// filters, conic, empty box, screenshot failure → alert

export interface TextRun {
  fg: string;                 // computed CSS color of the text (may be rgba; composited by the adjudicator)
  background: ResolvedBackground;
  size: TextSize;             // existing 'normal' | 'large'
}
```

`ScanResult` becomes `{ axe: AxeResults; textRuns: TextRun[] }`. `TextColorPair` is removed; only the runner, auditor, and their tests consume it.

**Bonus correctness:** the `layers` kind fixes a latent bug — today a semi-transparent ancestor `backgroundColor` is treated as opaque (`parseColor` drops alpha). Compositing the layer stack resolves it correctly.

### Runner background classification (in-page, per text run)

For each visible text run (existing tree-walker, dedup, size logic retained):
1. Resolve `fg = getComputedStyle(el).color`.
2. Walk ancestors collecting `backgroundColor` layers (top→bottom) until an opaque layer; always terminate with the `#ffffff` base. While walking, also inspect `getComputedStyle(cur).backgroundImage`:
   - `none` → contributes only its `backgroundColor` to the layer stack.
   - `linear-gradient(...)` / `radial-gradient(...)` → background kind = **`gradient`** (carry the raw `css`).
   - `url(...)` → background kind = **`image`**; record the run's bounding-box rect (`getBoundingClientRect`) for screenshotting.
   - `conic-gradient`, anything with `filter`/`backdrop-filter` on the run or an ancestor → **`unresolvable`** (reason).
3. The **nearest** non-`none` background-image ancestor wins the kind (image > gradient > layers), matching paint order closely enough for worst-case.

Precedence keeps it deterministic. If an `image` run's screenshot can't be captured or sampled, the runner re-emits it as `unresolvable` (so it surfaces as a review alert) rather than guessing — consistent with §5.

---

## 4. Declarative resolver (gradients + overlays) — pure

In `engine/contrast.ts` (helpers) + `render/run-contrast.ts` (orchestration):

- **Alpha compositing (`layers`):** fold the layer stack top→bottom with `out = a·src + (1−a)·dst` per channel (dst opaque) into one solid sRGB color → `checkContrast(fg, solid, size)`.
- **Gradient (`gradient`):** parse color stops from the raw `css` (`linear-`/`radial-gradient`; tolerate `deg`/`%`/`px` and `to <side>` syntax by ignoring geometry). Build a candidate set = each declared stop color **plus interpolated samples at a fixed interval** (default every 10%) between adjacent stops. Compute contrast of `fg` against each candidate; the **worst (minimum) ratio** is the verdict. Rationale: sRGB interpolation is not strictly monotonic in luminance, so interval sampling — not just the stop endpoints — is what makes the worst-case sound. `conic-gradient` or unparseable → `unresolvable`.

Both paths return a real pass/fail. Both are deterministic → **`blocker`** on failure.

---

## 5. Raster sampler (images) — pure decode + sample, browser capture

- **Capture (runner, Node side):** for an `image` run, `page.screenshot({ clip: rect })` → PNG buffer. Browser-level capture, so **no canvas CORS taint** (cross-origin hero images work).
- **`png.ts` (pure):** decode 8-bit RGBA PNG using `node:zlib` inflate; implement the five scanline filters (none/sub/up/average/paeth). ~150 lines, zero new deps. Returns `{ width, height, rgba: Uint8Array }`.
- **`sample.ts` (pure):** given the run's box pixels + `fg`:
  1. Drop **glyph-ink** pixels (colour-distance to `fg` below a tight threshold) and **anti-aliased edge** pixels (intermediate distance band) — they are text, not background.
  2. Over the remaining **background** pixels, find the **worst-case** (lowest contrast vs `fg`) and a couple of percentile swatches for evidence.
  3. Return swatches as opaque `rgb(...)` strings.
- Empty box, screenshot error, or all-pixels-look-like-text → **`unresolvable`**.
- Only image runs are screenshotted (rare in authored Canvas content), so per-scan cost stays bounded.

Image failure is a worst-case **estimate** → **`warning`** by default (see §6).

---

## 6. Auditor integration & severity-by-certainty

`run-contrast.ts` exposes `runContrastIssue(run, opts): AuditIssue | null`. The auditor's `[3]` loop calls it per `TextRun`.

| Background | Verdict source | Default fail severity | Message includes |
|---|---|---|---|
| `layers` | composite → `checkContrast` | `blocker` (`contrastFailSeverity`) | composited bg color, ratio |
| `gradient` | worst-case over stops + interval samples | `blocker` | worst stop color, ratio |
| `image` | worst-case over swatches | `warning` (`imageContrastSeverity`, new) | worst swatch, "estimated from rendered pixels" |
| `unresolvable` | — | `alert` (today's needs-review) | reason |

- `AuditorOptions` gains `imageContrastSeverity?: Severity` (default `'warning'`). Existing `contrastFailSeverity` (default `'blocker'`) governs the deterministic cases.
- All messages name the worst-case background so the remediation is obvious. `category: 'contrast'`, `id: 'contrast'` retained (WAVE vocabulary).
- The gate is unchanged: `blocker`/`error` withhold the badge; `warning`/`alert` are surfaced but don't.

---

## 7. Precision fix (`engine/contrast.ts`)

Today: `ratio = round2(raw); passesAA = ratio >= aa` — so `4.499` rounds to `4.5` and wrongly passes. Fix: compute the **raw** ratio, compare the **raw** value to thresholds, and round only the returned `ratio` display field. `ContrastResult` shape is unchanged.

- Behavior changes only within `[4.495, 4.5)` (and the analogous large/AAA/3.0 boundaries) — previously a false pass, now a correct fail. Matches WAVE's no-round convention.
- Update `contrast.test.ts` to assert the no-round boundary (e.g. a pair computing `4.499` fails AA).
- Optional, **not** doing unless requested: bump linearization `0.03928`→`0.04045` (current spec) — cannot change any 8-bit verdict, so skipped to avoid churn.

---

## 8. Oracle harness (`scripts/wave-oracle.ts`, dev-only — never shipped)

Proves "as good as / better than WAVE":

- Input: a corpus of local HTML fixtures (served from a temporary static server) + optional public URLs.
- For each page: run the local auditor (via `playwrightRunner`) **and** the live WAVE API (`reporttype=4`; key from `WAVE_API_KEY` env — never committed).
- Normalize both to `{ location, fg, bg, ratio, fails }` and print a three-way diff:
  - **agree** — solid-color cases; these must match WAVE (sanity).
  - **local-only** — gradient/image cases we flag and WAVE can't → our wins.
  - **WAVE-only** — anything WAVE caught that we missed → investigate.
- Not in CI (needs network + WAVE credits). Output is gitignored.

---

## 9. Test strategy

- **Pure / offline (the bulk):**
  - gradient-stop parser (linear/radial, `deg`/`%`/`to <side>`, multi-stop, malformed → unresolvable),
  - alpha compositor (stacked rgba → expected solid),
  - worst-case sampler (synthetic pixel arrays incl. text/AA-edge rejection),
  - PNG decoder (tiny fixtures, one per scanline filter),
  - `run-contrast` adjudicator (all 4 background kinds → expected issue + severity),
  - precision boundary (`4.499` fails AA).
- **Auditor:** extend the fake `ScanRunner` to emit `gradient`/`image`/`layers`/`unresolvable` runs → assert issues + severities. Browser-free.
- **Integration (env-gated, like the existing real-browser test):** real Chromium renders a gradient banner, a translucent callout, and text-over-image → assert end-to-end adjudication.
- **Oracle:** manual/dev runs against fixtures + a few public URLs.

---

## 10. Risks & caveats

- **Gradient worst-case is an approximation** (interval sampling). Mitigated by sampling between stops, not just at them; documented. Tighten interval if oracle shows misses.
- **Raster estimate uncertainty** → defaulted to `warning`, not `blocker`, so a noisy sample never false-blocks a page. Configurable.
- **Screenshot cost** — bounded by only screenshotting `image` runs; note in code if a page has many.
- **PNG decoder scope** — must handle exactly what Chromium/Playwright emits (8-bit RGBA, all filters). Fixture-tested per filter; fall back to `unresolvable` on any unsupported chunk rather than guessing.
- **Patent posture (reviewed):** the only pixel-sampling contrast patent (US 8,917,275, Microsoft) **expired 2023**; the active one (US 12,093,514, JPMorgan) covers a narrow interactive popup-on-click tool on *declared* colors, not a headless batch scanner. Worst-case sampling is documented prior art (WebAIM). Keep the batch-scanner shape; FTO before commercial launch. See research doc §4.3.

---

## 11. Success criteria

1. On solid-color text, local auditor and WAVE agree on pass/fail and ratio (oracle "agree" set).
2. On gradient and image text where WAVE reports nothing, the local auditor produces correct worst-case findings (oracle "local-only" set) — demonstrable on the fixture corpus.
3. All pure modules have offline unit tests; the auditor's existing fake-runner tests still pass; the env-gated integration test adjudicates all three hard cases.
4. No new runtime dependencies; no frozen-contract changes; `npm test` stays fully offline.
5. The precision boundary bug is fixed and asserted.

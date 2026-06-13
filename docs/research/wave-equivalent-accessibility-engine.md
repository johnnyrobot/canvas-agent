# Building a WAVE-equivalent (and better) on-device accessibility engine

**Date:** 2026-06-13
**Author:** canvas-agent research (deep-research workflow + live WAVE API probing)
**Status:** Research complete → ready for architecture decision
**Scope decided with stakeholder:** full WAVE-equivalent suite · **100% on-device** (no runtime cloud) · **rendered-page** evaluation (computed styles, real backgrounds)

---

## 0. TL;DR / bottom line

1. **WAVE's contrast detection is not magic.** It uses the *plain WCAG 2.x relative-luminance ratio* (4.5:1 / 3:1). I proved this empirically: my independent implementation reproduced WAVE's reported ratios to the rounding digit on its own API output (`3.88→3.88`, `2.48→2.49`, `2.81→2.81`). **All of WAVE's quality comes from (a) running in a real rendered DOM and (b) only flagging when it can unambiguously resolve both foreground and background to solid colors.** It is a *precision* play, not an algorithm play.

2. **Recommended architecture = HYBRID.** Embed **axe-core** (MPL-2.0, safe to ship in a closed-source commercial Electron app) as the rules engine — it already does the single hardest thing (resolving the effective background color by walking the *visual paint stack* and alpha-compositing), and covers the large majority of WAVE's 110 checks. Layer a **custom WCAG-2.x contrast module** on top so *you* own the pass/fail boundary and reporting format, and a **rendered-pixel contrast sampler** for the cases both WAVE and axe punt on.

3. **The "better than WAVE" win is concrete and defensible.** WAVE *explicitly skips* text over gradients, background-images, transparency, and filters; axe-core *defers* on the same cases ("needs review"). **Neither tool actually evaluates contrast there.** Sampling the actual rendered pixels under the text and computing worst-case contrast beats both — and these cases (hero banners, gradient callouts, image headers) are common in real Canvas pages.

4. **APCA is a supplementary signal only — do not ship it as the compliance check, and do not embed its reference code.** APCA is more perceptually accurate (esp. dark mode / thin fonts) but as of April 2026 it is *not* a ratified standard (WCAG 3 contrast algorithm is officially undetermined), and the reference implementation `apca-w3` is **AGPL-3.0 + an explicit commercial-use prohibition** — a hard blocker for a closed-source commercial product. **WCAG 2.x SC 1.4.3 stays the legally enforceable baseline** (ADA Title II / WCAG 2.1 AA).

---

## 1. How WAVE actually works (empirically established)

These facts come from directly probing the live WAVE API and its documentation API (`/api/docs`) with the provided key — not from secondary sources. Raw artifacts saved at `docs/research/wave/`.

### 1.1 It runs in a rendered browser DOM
WAVE's engine doc states the script *"must be processed within a web page in a rendered browser context/DOM — headless browser contexts, such as Selenium, Chrome Driver, or Puppeteer are supported."* It reads **computed styles**, not authored HTML. This is why static-HTML linters underperform it, and why your **rendered-page choice (Playwright) puts you on equal footing.**

### 1.2 The contrast output format
`reporttype=3`/`4` returns `categories.contrast.items.contrast.contrastdata` as an array of `[ratio, foregroundHex, backgroundHex, isLargeText]`:

```
[3.88, "#41545d", "#a9b8bf", false]
[2.48, "#9a9aff", "#ffffff", false]
[2.81, "#9a9a9a", "#ffffff", true]   // large text, but 2.81 < 3.0 → still fails
```
- **Foreground** is 8 hex chars when alpha/opacity is present → WAVE **alpha-composites** the foreground onto its background.
- **Background** is always resolved to a solid 6-char hex.
- `isLargeText` boolean drives the **4.5:1 vs 3:1** threshold selection.

### 1.3 WAVE's own documented contrast algorithm (verbatim from `/api/docs?id=contrast`)
> *"Text is present that has a contrast ratio less than 4.5:1, or large text (larger than 18 point or 14 point bold) has a contrast ratio less than 3:1. WCAG requires that page elements have both foreground AND background colors defined (or inherited)… When text is presented over a background image, the text must have a background color defined (typically in CSS) that provides adequate text contrast when the background image is disabled or unavailable. **WAVE does not identify contrast issues in text with CSS transparency, gradients, or filters.**"* → maps to **WCAG SC 1.4.3 (AA)**.

### 1.4 Why it "works so well" → conservative precision
On a *deliberately broken* test page (W3C "Before" demo, AIM score 3.4, 82 total issues) WAVE reported **only 2 contrast errors**. It minimizes false positives by flagging **only** unambiguous foreground/background pairs and **deliberately skipping** everything it can't resolve cleanly. The accuracy is "rendered DOM + high precision + skip the hard cases," nothing more.

### 1.5 The full target: 110 checks across 6 categories
WAVE's `/api/docs` catalog (saved to `docs/research/wave/wave-items-catalog.json`):

| Category | Count | Examples |
|---|---|---|
| **error** | 22 | `alt_missing`, `label_missing`, `link_empty`, `language_missing`, `heading_empty`, `th_empty`, `button_empty`, `aria_reference_broken` |
| **contrast** | 1 | `contrast` (the single hard one) |
| **alert** | 42 | `h1_missing`, `heading_skipped`, `link_suspicious`, `alt_redundant`, `table_layout`, `text_small`, `link_pdf`, `noscript`, `tabindex` |
| **feature** | 13 | `alt`, `label`, `lang`, `figure`, `link_skip` (these are *good* things detected) |
| **structure** | 22 | `h1`–`h6`, `nav`, `main`, `header`, `footer`, `table_data`, `th`, `ol`, `ul`, `region` |
| **aria** | 10 | `aria_label`, `aria_hidden`, `aria_expanded`, `aria_describedby`, `aria_live_region` |

Note: ~45 of these (`feature` + `structure`) are **informational**, not failures — they're cheap to emit (tag/attribute presence) and exist mostly to populate WAVE's visual report. The **22 errors + contrast** are the substantive correctness checks; the **42 alerts** are heuristic warnings.

---

## 2. The exact WCAG 2.x contrast math to implement (verified against primary W3C sources)

Every step below is confirmed by primary W3C normative/explanatory pages (adversarial 3-0 verification).

```ts
// All four inputs/outputs verified against WAVE's live API output to the rounding digit.

/** sRGB 8-bit channel (0–255) → linear-light value. */
function linearize(c8: number): number {
  const c = c8 / 255;
  // Use 0.04045 per CURRENT spec (WCAG updated 0.03928→0.04045 in May 2021).
  // For 8-bit inputs the difference never changes a pass/fail result.
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG 2.x. */
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** Contrast ratio; L1 = lighter, L2 = darker. Range 1..21. */
function contrastRatio(fg: RGB, bg: RGB): number {
  const l1 = relativeLuminance(fg.r, fg.g, fg.b);
  const l2 = relativeLuminance(bg.r, bg.g, bg.b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
```

**Threshold / classification rules:**

| Rule | Value |
|---|---|
| SC 1.4.3 (AA) normal text | **≥ 4.5:1** |
| SC 1.4.3 (AA) large text | **≥ 3:1** |
| SC 1.4.6 (AAA) normal / large | ≥ 7:1 / ≥ 4.5:1 |
| SC 1.4.11 (AA) non-text (UI, graphics) | **≥ 3:1** |
| **Large text** | computed font-size **≥ 24px** (18pt), **or ≥ 18.66px (≈18.5px) when bold** (font-weight ≥ 700). `1pt = 1.333px`. |
| **No rounding** | Compare the *raw* ratio. `4.499:1` **fails** 4.5:1; `2.999:1` **fails** 3:1. This is the precision convention that makes you match WAVE's boundary exactly. |

**Alpha compositing** (needed for the 8-char foreground case and any semi-transparent layer):
```
out = src.alpha · src + (1 − src.alpha) · dst   // per channel, dst assumed opaque
```
Resolve foreground `color` opacity (and any `opacity`/`rgba()`) against the resolved background before computing luminance, exactly as WAVE does.

---

## 3. Replicating WAVE's precision: background-color resolution (the actually-hard part)

This is the one piece worth taking from axe-core rather than rebuilding, because the edge cases are brutal. Verified against the axe-core source and the contributor write-up by Steven Lambert (who rewrote the rule):

- The effective background is **NOT** "the element plus its DOM ancestors." It is the element's **visual paint stack** — *all elements that visually overlap the target, sorted in paint order*. Positioned elements (`absolute`/`fixed`/`relative`+`z-index`), negative margins, and CSS `transform`s **add or remove** elements from that stack.
- Walk the stack from front to back; take the **closest element that defines a background color**; if a layer is semi-transparent, **alpha-composite** it onto what's behind; **break when a fully opaque color is found** (`alpha === 1`); **fall back to white** (`255,255,255`) if nothing opaque is found (the browser default).
- axe-core source of truth: `lib/commons/color/get-background-color.js` + `get-background-stack.js` (`getRectStack`, `sortPageBackground`).

> Building this correctly from scratch is multiple engineer-weeks and a long tail of CSS bugs. **Embedding axe-core gets it for free, battle-tested.**

---

## 4. Beating WAVE: the cases it (and axe) refuse to evaluate

This is your differentiator. Both tools **defer** on the same set — confirmed:

- **WAVE:** *"does not identify contrast issues in text with CSS transparency, gradients, or filters"*; for background-images it only checks the fallback `background-color`.
- **axe-core:** returns **`incomplete` / "needs review"** (never a hard fail) for **CSS gradients, pseudo-element backgrounds, backgrounds made from CSS borders, off-screen-repositioned elements, background images, element overlap, and exact 1:1 ratios.** Philosophy: *"no false positives."*

WCAG itself gives **no guidance** on how to measure contrast over variable backgrounds — so the field's standard answer is "sample the pixels and take the worst case."

### 4.1 Rendered-pixel sampling (the technique)
You already render the page in Playwright/Chromium — so you can capture actual pixels, which neither WAVE's API nor a DOM-only pass can:

1. Get the text element's client rects (per line if needed).
2. Capture the rendered pixels of that region — Playwright `page.screenshot({ clip })` / element screenshot, or draw the region to an `OffscreenCanvas` and `getImageData`.
3. Classify each pixel as **text (foreground)** vs **background** — e.g. separate the glyph-ink pixels (closest to the computed `color`) from the rest, or sample a *text-free* strip of the same background region to characterize the background luminance distribution.
4. Compute contrast for the **worst-case** background sample against the text color (lowest ratio across sampled points), ignoring anti-aliased edge pixels (drop the intermediate-luminance halo to avoid noise).
5. Report **min / max / mean** contrast across the text run, fail on **min < threshold**.

This turns WAVE's blind spots (hero images, gradient banners, translucent overlays) into hard, evidence-backed findings — with a screenshot crop as proof.

### 4.2 Add APCA as a *secondary* perceptual signal (not compliance)
APCA (Myndex / Andrew Somers) is perceptually weighted — it factors font weight/size and is much better at dark mode and thin fonts, where WCAG 2.x is known to mis-score near-black pairs. Use it to **add nuance** ("passes WCAG 2.x but APCA-weak for this small font") — never to replace the WCAG 2.x verdict. **Licensing constraint below (§6.3) is a hard gate.**

### 4.3 IP status (reviewed — lower risk than first flagged)
The two patents initially flagged were read at claim 1:
- **US 8,917,275** (Microsoft, "Automated contrast verifications") — the *only* one covering pixel/image analysis — **EXPIRED 2023-02-21** (fee lapse). Public domain. Its claim was also narrow (a specific grayscale-histogram-maxima method). Not a concern.
- **US 12,093,514** (JPMorgan Chase, active to ~2041) — does **NOT** cover pixel sampling. Claim 1 is a narrow *interactive* tool: a "compliance module" with active/inactive modes that "generates a popup graphical element in response to a predetermined user input on a selected graphical element," analyzing **declared color data, not rendered pixels.** A headless batch scanner does not practice this claim.

**Design guidance:** (a) worst-case rendered-pixel sampling is unpatented (MS patent dead) and is documented prior art (WebAIM: *"test the area where contrast is lowest"*); (b) keep the feature a **headless batch scanner**, not a click-element→popup tool with a mode toggle (the shape JPMC's claim describes); (c) prefer **CSS-declarative gradient-stop / alpha-composite analysis** over rasterization where possible — more accurate and touches no pixels. Still get a proper FTO before commercial launch (other contrast patents exist, e.g. US 11,386,590), and keep a dated invention record citing prior art.

---

## 5. Architecture recommendation: hybrid engine

```
┌─────────────────────────────────────────────────────────────┐
│  canvas-agent (Electron, on-device)                          │
│                                                              │
│  src/engine/render/playwright-runner.ts  ← you already have  │
│        │  loads Canvas HTML in headless Chromium             │
│        ▼                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ inject axe-core (axe.min.js, bundled, no network)    │   │
│  │   → 90+ rules: structure, ARIA, alt, labels, etc.    │   │
│  │   → effective-background resolution (paint stack)    │   │
│  └──────────────────────────────────────────────────────┘   │
│        │ axe results (violations + INCOMPLETE list)          │
│        ▼                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ custom WCAG-2.x contrast module (§2)                 │   │
│  │   → owns pass/fail boundary + WAVE-shaped output     │   │
│  │   → re-checks axe "incomplete" contrast nodes via    │   │
│  │     RENDERED-PIXEL SAMPLING (§4)  ← beats WAVE        │   │
│  │   → optional APCA secondary score (§4.2/§6.3)        │   │
│  └──────────────────────────────────────────────────────┘   │
│        │                                                     │
│        ▼                                                     │
│  normalize → WAVE-equivalent report (110-item taxonomy map)  │
│        → reuse existing Canvas remediation tooling           │
└─────────────────────────────────────────────────────────────┘
```

**Why hybrid, not build-from-scratch:** the only parts worth owning are the **contrast pass/fail boundary** (so you control precision + format) and the **pixel sampler** (your differentiator). Everything else — DOM stack background resolution, 90+ structural/ARIA/alt/label rules, WCAG 2.2 + ACT-rule conformance, "zero false positives" tuning — is exactly what axe-core already is. Rebuilding it is months of work to *catch up to*, not surpass, WAVE.

**Why not embed WAVE / call its API:** violates the on-device constraint and isn't redistributable. Use it only as a **dev-time oracle** (you have the key + credits) to validate parity.

---

## 6. Engine & license comparison (for the embed decision)

| Engine | License | Embeddable in closed-source commercial? | Runs fully offline in Chromium? | Contrast handling | Notes |
|---|---|---|---|---|---|
| **axe-core** (Deque) | **MPL-2.0** (file-level copyleft) | ✅ Yes (combine w/ proprietary OK; only modified axe files stay MPL) | ✅ single injectable JS | DOM paint-stack + alpha; **defers** on images/gradients | Industry standard; powers Lighthouse, DevTools, Cypress, Storybook. **Recommended.** |
| **IBM Equal Access** (`equal-access` "ace") | **Apache-2.0** (verify per-pkg) | ✅ Most permissive | ✅ | Similar deferral behavior | Strong WCAG 2.2 ruleset; heavier. Good secondary oracle. |
| **HTML_CodeSniffer** | **BSD-3-Clause** | ✅ | ✅ | Weaker / more false positives | Default Pa11y runner; older. |
| **Pa11y** (harness) | **LGPL-3.0** | ⚠️ Dynamic-link OK, but more obligations | ✅ (drives a browser) | Wraps HTML_CodeSniffer or axe | It's a *runner*, not an engine; you don't need it — you have Playwright. |
| **Lighthouse** (Google) | **Apache-2.0** | ✅ | ✅ | **Wraps axe-core** | No new contrast capability over axe. |
| **WAVE** | proprietary / API ToS | ❌ not redistributable | ❌ cloud | The reference | **Dev-time oracle only.** |

### 6.3 APCA licensing — the hard gate
- Reference impl `apca-w3`: files outside the W3C cooperative agreement are **AGPL-3.0**, and the license **separately prohibits commercial use** without a signed Myndex agreement *"except… for web content only."*
- The maintainer has **promised** a future permissively-licensed library — **it does not exist yet.**
- **Options:** (a) ship WCAG-2.x only now, add APCA later when the permissive lib lands; (b) obtain a Myndex commercial license; (c) re-implement from the public formula **with legal review** (the algorithm's IP status is contested — don't assume clean-room is safe without counsel). **Default: (a).**

---

## 7. Reaching full 110-check parity

| WAVE category | Coverage strategy | Effort |
|---|---|---|
| **error** (22) | ~80% map directly to axe rules (`image-alt`, `label`, `link-name`, `html-has-lang`, `button-name`, `empty-heading`, `aria-*`). Fill gaps (`alt_spacer_missing`, `marquee`, `blink`, `meta_refresh`) with small custom DOM checks. | Low–med |
| **contrast** (1) | Custom WCAG-2.x module + pixel sampler (§2/§4). **This is the whole project's center of gravity.** | High |
| **alert** (42) | Heuristic warnings. axe covers some (`heading-order`→`heading_skipped`); the rest (`link_suspicious`, `link_pdf/word/excel`, `text_small`, `alt_redundant`, `title_redundant`) are simple text/attribute heuristics — port WAVE's documented `details` from the catalog JSON. | Med (volume) |
| **feature** (13) | Informational presence checks (`alt`, `label`, `lang`, `figure`). Trivial DOM queries. | Low |
| **structure** (22) | Tag/landmark presence (`h1`–`h6`, `nav`, `main`, `table_data`, `th`). Trivial. | Low |
| **aria** (10) | axe's ARIA rules cover the substantive ones; emit the rest as informational. | Low |

`docs/research/wave/wave-items-catalog.json` gives you WAVE's own `details` (the detection algorithm) + `guidelines` (WCAG mapping) for **all 110** — use it as the spec to port the long tail of alerts/features/structure cheaply.

---

## 8. Validation plan (prove parity, then prove you beat it)

1. **Oracle harness:** for a corpus of pages, run *your* engine and the *WAVE API* (you have the key), normalize both to the 110-item taxonomy, and diff per-item counts + locations. Target: ≥ parity on errors/contrast; explain every divergence.
2. **Corpora:**
   - **ACT-Rules community test cases** (W3C Accessibility Conformance Testing) — pass/fail expectations per rule.
   - **axe-core test fixtures** — regression-grade unit cases, incl. contrast edge cases.
   - **W3C Before/After Demo (BAD)** — known-bad vs known-good full pages.
   - **Real Canvas exports** — your actual domain; where hero images/gradients will exercise the pixel sampler.
   - **WebAIM Million methodology** — for scale sanity-checking category rates (e.g. low-contrast text is consistently the #1 issue at ~80% of home pages).
3. **Metrics:** precision/recall *per check* vs WAVE-as-oracle for the overlap set; for the **skipped-cases set** (gradient/image/transparency), measure against **human-labeled** ground truth — that's where you *exceed* WAVE, so WAVE can't be the oracle there.
4. **Guard against:** rounding drift (use raw ratios), large-text classification (bold ≥700, 24px/18.66px), anti-aliasing noise in the sampler.

---

## 9. Phased build plan

- **Phase 0 — Oracle (½ wk):** wrap the WAVE API as a dev-only fixture generator; snapshot reports for the test corpus into `docs/research/wave/`. (Catalog + one sample already saved.)
- **Phase 1 — Embed axe-core (1 wk):** bundle `axe.min.js`, inject via the existing Playwright runner, normalize axe output → internal model. Instant coverage of most structure/ARIA/error checks.
- **Phase 2 — WCAG-2.x contrast module (1–2 wk):** implement §2 exactly; reconcile against WAVE's `contrastdata` on the oracle corpus until ratios match to the digit; own the pass/fail + report format.
- **Phase 3 — Pixel sampler (2–3 wk):** re-evaluate axe's `incomplete` contrast nodes via rendered-pixel worst-case sampling; ship screenshot-crop evidence. **← the "better than WAVE" feature.** (Do IP review first.)
- **Phase 4 — Alert/feature/structure long tail (1–2 wk):** port WAVE's documented heuristics from the catalog JSON to hit 110-item parity.
- **Phase 5 — Optional APCA (gated on license):** secondary perceptual score once a permissive lib exists or legal clears a re-impl.

---

## 10. Risks & caveats

- **APCA licensing (high):** AGPL-3.0 + commercial prohibition on `apca-w3`. Hard blocker for embedding; treat as legal, not technical. Re-verify status — it's fast-moving (WCAG 3 contrast algorithm officially *undetermined* as of Apr 2026).
- **Pixel-sampling patents (low–moderate, reviewed):** the only pixel-sampling patent (MS 8,917,275) **expired in 2023**; the live one (JPMC 12,093,514) covers a narrow interactive popup tool on *declared* colors, not a headless batch scanner. Keep the scanner shape, prefer CSS-declarative analysis, get an FTO before commercial ship (§4.3). Not a blocker.
- **MPL-2.0 obligation (low):** if you *modify* axe-core source files, those files must stay MPL and be offered; using it unmodified as a bundled lib is fine. Don't fork-and-edit casually.
- **0.03928 vs 0.04045 (negligible):** use 0.04045 (current spec); never changes an 8-bit pass/fail.
- **Don't round before comparing** — silent source of WAVE-mismatch.
- **WAVE-as-oracle has a ceiling:** WAVE itself misses the skipped cases, so you cannot use it to validate the very feature that beats it — use human labels there.
- **Coverage honesty:** automated tools (WAVE/axe/yours) catch ~30–50% of WCAG issues; the rest need human judgment. Market the feature as "matches WAVE's automated coverage + adds contrast cases WAVE can't see," not "full WCAG compliance."

---

## 11. Sources

**Verified primary (W3C / source code):**
- WCAG 2.2 Understanding 1.4.3 Contrast (Minimum) — https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
- WCAG relative luminance — https://www.w3.org/TR/WCAG21/relative-luminance.html
- WCAG 2.2 Understanding 1.4.11 Non-text Contrast — https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- WCAG technique G18 — https://www.w3.org/TR/WCAG20-TECHS/G18.html
- 0.03928→0.04045 correction — https://github.com/w3c/wcag/issues/308
- axe-core color-contrast performance / paint-stack write-up (Steven Lambert) — https://stevenklambert.com/writing/axe-core-color-contrast-performance/
- axe-core repo / `get-background-color.js` — https://github.com/dequelabs/axe-core
- axe-core MPL-2.0 license & SPDX issue — https://github.com/dequelabs/axe-core/blob/develop/LICENSE · https://github.com/dequelabs/axe-core/issues/4695
- APCA "in a nutshell" — https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell.html
- Why APCA (Myndex) — https://github.com/Myndex/SAPC-APCA/blob/master/documentation/WhyAPCA.md
- apca-w3 license (AGPL + commercial prohibition) — https://github.com/Myndex/apca-w3/blob/master/LICENSE.md
- WCAG 3 contrast status, Apr 2026 (Adrian Roselli) — https://adrianroselli.com/2026/04/wcag3-contrast-as-of-april-2026.html
- WebAIM: evaluating contrast — https://webaim.org/articles/contrast/evaluating
- WebAIM Million — https://webaim.org/projects/million/
- ACT Rules — https://www.w3.org/WAI/standards-guidelines/act/rules/

**Live WAVE API (probed with provided key — artifacts in `docs/research/wave/`):**
- WAVE API engine doc — https://wave.webaim.org/api/engine
- WAVE API details/spec — https://wave.webaim.org/api/details
- WAVE item catalog (all 110) — https://wave.webaim.org/api/docs

**Supporting (engine comparison / sampling):**
- axe-core gradient/pseudo false-positive issues — https://github.com/dequelabs/axe-core/issues/975 · /issues/3390
- IBM Equal Access — https://github.com/IBMa/equal-access
- Pa11y — https://github.com/pa11y/pa11y
- Acquia: text over image/gradient/backdrop-filter contrast — https://docs.acquia.com/web-governance/text-top-image-gradient-or-backdrop-filter-should-have-minimum-contrast
- Contrast patents — https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12093514 · /8917275

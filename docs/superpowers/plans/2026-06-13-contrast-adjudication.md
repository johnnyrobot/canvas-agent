# Contrast Adjudication for Variable Backgrounds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adjudicate worst-case text contrast over gradients, semi-transparent overlays, and background images — the cases WAVE and axe-core skip — instead of punting them to a manual-review alert.

**Architecture:** Approach A from the spec. The Playwright runner does *capture only* (classifies each text run's background, screenshots image runs). All contrast math lives in pure, dependency-free, offline-tested modules that reuse `engine/contrast.ts`. The auditor swaps its contrast loop to a new pure adjudicator. No frozen-contract changes; no new runtime deps.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:test` + `node:assert/strict`, `tsx --test`, Playwright + axe-core (already deps), `node:zlib` (vendored PNG decode).

**Spec:** `docs/superpowers/specs/2026-06-13-contrast-adjudication-design.md`

**Conventions (match existing code):**
- Tests are colocated `*.test.ts`, run with `npx tsx --test <file>` (single) or `npm test` (all).
- Imports use `.js` specifiers (e.g. `from './contrast.js'`).
- Typecheck with `npm run typecheck`.
- Browser test is env-gated: `RUN_BROWSER_INTEGRATION=1` + node:test `{ skip }`.
- Each task ends green and is committed.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/engine/contrast.ts` *(modify)* | Precision fix; add `parseColorAlpha`, `compositeLayers`, `parseGradientStops` helpers. |
| `src/engine/render/png.ts` *(create)* | Vendored 8-bit RGB/RGBA PNG decoder on `node:zlib`. |
| `src/engine/render/sample.ts` *(create)* | Pure worst-case background-swatch extraction from decoded pixels. |
| `src/engine/render/types.ts` *(modify)* | `ResolvedBackground` union + `TextRun`; `ScanResult.textRuns`. |
| `src/engine/render/run-contrast.ts` *(create)* | Pure adjudicator: `TextRun` → `AuditIssue \| null` across all bg kinds. |
| `src/engine/render/auditor.ts` *(modify)* | Contrast loop calls `run-contrast`; add `imageContrastSeverity`. |
| `src/engine/render/playwright-runner.ts` *(modify)* | In-page background classifier; Node-side screenshot→decode→sample. |
| `scripts/wave-oracle.ts` *(create, dev-only)* | Local-engine-vs-live-WAVE contrast diff. |

---

## Task 1: Precision fix — compare the raw ratio, not the rounded one

**Files:**
- Modify: `src/engine/contrast.ts:152-167`
- Test: `src/engine/contrast.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/engine/contrast.test.ts`:

```ts
test('a pair whose raw ratio is just below 4.5 fails AA even though it displays as 4.5', () => {
  // #767776 on white computes to ~4.496:1 (verified): displays as 4.5 after rounding,
  // but must FAIL the 4.5 threshold — the old round-before-compare wrongly passed it.
  const r = checkContrast('#767776', '#ffffff');
  assert.equal(r.ratio, 4.5);      // display value is rounded to 2dp
  assert.equal(r.passesAA, false); // raw 4.496 < 4.5 → fail
  assert.equal(r.level, 'fail');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/engine/contrast.test.ts`
Expected: FAIL — the new test reports `passesAA` was `true` (old code rounds 4.496→4.5 then `4.5 >= 4.5`).

- [ ] **Step 3: Write minimal implementation** — replace `checkContrast` (lines 152-167) with:

```ts
export const checkContrast: ContrastChecker = (fg, bg, size: TextSize = 'normal'): ContrastResult => {
  const l1 = relativeLuminance(parseColor(fg));
  const l2 = relativeLuminance(parseColor(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  const rawRatio = (lighter + 0.05) / (darker + 0.05);

  const aa = size === 'large' ? WCAG.AA_LARGE : WCAG.AA_NORMAL;
  const aaa = size === 'large' ? WCAG.AAA_LARGE : WCAG.AAA_NORMAL;

  // Compare the RAW ratio to the thresholds (WCAG: do not round before comparing).
  const passesAA = rawRatio >= aa;
  const passesAAA = rawRatio >= aaa;
  const level: ContrastResult['level'] = passesAAA ? 'AAA' : passesAA ? 'AA' : 'fail';

  return { ratio: round2(rawRatio), level, passesAA, passesAAA, size };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/engine/contrast.test.ts`
Expected: PASS — the new boundary test passes and all existing anchors (21.0, 4.0 red, 5.14 green, etc.) still pass (none sit in the `[4.495,4.5)` band).

- [ ] **Step 5: Commit**

```bash
git add src/engine/contrast.ts src/engine/contrast.test.ts
git commit -m "fix(contrast): compare raw ratio to thresholds, not the rounded value"
```

---

## Task 2: Gradient color-stop parser

**Files:**
- Modify: `src/engine/contrast.ts` (add exports)
- Test: `src/engine/contrast.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/engine/contrast.test.ts`:

```ts
import { parseGradientStops } from './contrast.js';

test('parseGradientStops extracts colors and drops the direction token', () => {
  assert.deepEqual(
    parseGradientStops('linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)'),
    ['rgb(255, 0, 0)', 'rgb(0, 0, 255)'],
  );
});

test('parseGradientStops handles "to <side>", hex, named colors, and radial', () => {
  assert.deepEqual(parseGradientStops('linear-gradient(to right, #fff, #000)'), ['#fff', '#000']);
  assert.deepEqual(parseGradientStops('radial-gradient(circle, red, blue 80%)'), ['red', 'blue']);
});

test('parseGradientStops returns [] for non-gradients and conic gradients', () => {
  assert.deepEqual(parseGradientStops('url("x.png")'), []);
  assert.deepEqual(parseGradientStops('conic-gradient(red, blue)'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/engine/contrast.test.ts`
Expected: FAIL — `parseGradientStops` is not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/engine/contrast.ts`:

```ts
/** Split on top-level commas, respecting parentheses (so rgb(...) stays intact). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Leading CSS color token of a gradient color-stop segment (drops a trailing position). */
function leadingColorToken(segment: string): string | null {
  const s = segment.trim();
  const fn = /^(rgba?|hsla?)\(/i.exec(s);
  if (fn) {
    const close = s.indexOf(')');
    return close === -1 ? null : s.slice(0, close + 1);
  }
  const tok = s.split(/\s+/)[0];
  return tok && tok.length > 0 ? tok : null;
}

/**
 * Parse the color stops of a linear/radial gradient as CSS color strings. Returns
 * [] when `css` is not a parseable linear/radial gradient (conic, url(), none, …).
 * A leading direction/angle/shape segment whose leading token is not a color is
 * left in the list as a non-color token; callers parse each token and skip the
 * ones that don't resolve to a color.
 */
export function parseGradientStops(css: string): string[] {
  const m = /^(?:repeating-)?(?:linear|radial)-gradient\((.*)\)$/is.exec(css.trim());
  if (!m) return [];
  const stops: string[] = [];
  for (const part of splitTopLevel(m[1]!)) {
    const tok = leadingColorToken(part);
    if (tok) stops.push(tok);
  }
  return stops;
}
```

Note: a direction segment like `90deg` or `to right` yields the token `90deg` / `to`, which the *adjudicator* (Task 6) discards because `parseColor` throws on it. The two tests above expect only the real colors because the direction token is the first part and its leading token (`90deg`/`to`) is not in the expected arrays — so update the first two tests to expect the colors only AFTER the adjudicator filters. For THIS unit, the raw token list includes the direction. Adjust the assertions:

```ts
// parseGradientStops is raw (keeps the direction token); the adjudicator filters it.
test('parseGradientStops extracts colors and drops the direction token', () => {
  assert.deepEqual(
    parseGradientStops('linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)'),
    ['90deg', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)'],
  );
});
test('parseGradientStops handles "to <side>", hex, named colors, and radial', () => {
  assert.deepEqual(parseGradientStops('linear-gradient(to right, #fff, #000)'), ['to', '#fff', '#000']);
  assert.deepEqual(parseGradientStops('radial-gradient(circle, red, blue 80%)'), ['circle', 'red', 'blue']);
});
```

(Use these corrected assertions in Step 1.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/engine/contrast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/contrast.ts src/engine/contrast.test.ts
git commit -m "feat(contrast): parse linear/radial gradient color stops"
```

---

## Task 3: Alpha parsing + layer compositing

**Files:**
- Modify: `src/engine/contrast.ts` (add exports)
- Test: `src/engine/contrast.test.ts`

- [ ] **Step 1: Write the failing test** — append to `src/engine/contrast.test.ts`:

```ts
import { parseColorAlpha, compositeLayers } from './contrast.js';

test('parseColorAlpha reads alpha from rgba, hex8, and treats transparent as a=0', () => {
  assert.deepEqual(parseColorAlpha('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColorAlpha('#ff000080'), { r: 255, g: 0, b: 0, a: 128 / 255 });
  assert.deepEqual(parseColorAlpha('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColorAlpha('#fff').a, 1);
});

test('compositeLayers folds a 50% black overlay onto white to mid-grey', () => {
  // top→bottom: a 50%-alpha black over the opaque white base → rgb(128,128,128) (rounded).
  assert.equal(compositeLayers(['rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)']), 'rgb(128, 128, 128)');
});

test('compositeLayers returns the single opaque layer unchanged', () => {
  assert.equal(compositeLayers(['#ffffff']), 'rgb(255, 255, 255)');
  assert.equal(compositeLayers(['rgb(20, 40, 60)']), 'rgb(20, 40, 60)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/engine/contrast.test.ts`
Expected: FAIL — `parseColorAlpha`/`compositeLayers` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/engine/contrast.ts`:

```ts
export interface Rgba { r: number; g: number; b: number; a: number; }

/** Parse a CSS color including alpha. 'transparent' → a=0. Throws on invalid input. */
export function parseColorAlpha(input: string): Rgba {
  if (typeof input !== 'string') throw new Error('Invalid color: expected a string');
  const lower = input.trim().toLowerCase();
  if (lower === '') throw new Error('Invalid color: empty string');
  if (lower === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  if (lower.startsWith('#')) {
    const { r, g, b } = parseColor(lower); // parseColor takes only r/g/b
    const h = lower.slice(1);
    let a = 1;
    if (h.length === 4) a = parseInt(h[3]! + h[3]!, 16) / 255;
    else if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
    return { r, g, b, a };
  }
  if (lower.startsWith('rgb')) {
    const { r, g, b } = parseColor(lower);
    const m = /^rgba?\(([^)]*)\)$/.exec(lower);
    let a = 1;
    if (m) {
      const body = m[1]!.replace(/\//g, ' ').trim();
      const parts = body.includes(',') ? body.split(',') : body.split(/\s+/);
      const toks = parts.map((p) => p.trim()).filter((p) => p.length > 0);
      if (toks.length === 4) {
        const t = toks[3]!;
        const parsed = t.endsWith('%') ? Number(t.slice(0, -1)) / 100 : Number(t);
        a = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
      }
    }
    return { r, g, b, a };
  }
  const { r, g, b } = parseColor(lower); // named color → opaque
  return { r, g, b, a: 1 };
}

/**
 * Composite a stack of CSS color layers (top → bottom) into one solid `rgb(...)`.
 * Layers below the last opaque one are irrelevant; an opaque white base is assumed
 * so even an all-transparent stack resolves to white. Unparseable layers are skipped.
 */
export function compositeLayers(layers: string[]): string {
  let r = 255;
  let g = 255;
  let b = 255; // opaque white base
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    let c: Rgba;
    try {
      c = parseColorAlpha(layers[i]!);
    } catch {
      continue;
    }
    const a = c.a;
    r = Math.round(c.r * a + r * (1 - a));
    g = Math.round(c.g * a + g * (1 - a));
    b = Math.round(c.b * a + b * (1 - a));
  }
  return `rgb(${r}, ${g}, ${b})`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/engine/contrast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/contrast.ts src/engine/contrast.test.ts
git commit -m "feat(contrast): parseColorAlpha + compositeLayers (alpha compositing)"
```

---

## Task 4: Vendored PNG decoder

**Files:**
- Create: `src/engine/render/png.ts`
- Test: `src/engine/render/png.test.ts`

- [ ] **Step 1: Write the failing test** — create `src/engine/render/png.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng } from './png.js';

/** Assemble a PNG chunk (CRC is zeroed; the decoder ignores CRC). */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

/** Build an 8-bit RGBA (colorType 6) PNG from already-filtered scanlines. */
function makePng(width: number, height: number, filteredRows: Buffer[]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(Buffer.concat(filteredRows));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

test('decodePng round-trips a filter-0 (none) RGBA image', () => {
  // 2x1: red, then green.
  const row = Buffer.from([0, /*px0*/ 255, 0, 0, 255, /*px1*/ 0, 255, 0, 255]); // leading 0 = filter none
  const png = makePng(2, 1, [row]);
  const img = decodePng(png);
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.deepEqual([...img.rgba], [255, 0, 0, 255, 0, 255, 0, 255]);
});

test('decodePng applies the Up filter (type 2)', () => {
  // 1x2: row0 none = (10,20,30,255); row1 up adds row0 → stored deltas (5,5,5,0) → (15,25,35,255).
  const row0 = Buffer.from([0, 10, 20, 30, 255]);
  const row1 = Buffer.from([2, 5, 5, 5, 0]);
  const png = makePng(1, 2, [row0, row1]);
  const img = decodePng(png);
  assert.deepEqual([...img.rgba], [10, 20, 30, 255, 15, 25, 35, 255]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/engine/render/png.test.ts`
Expected: FAIL — `./png.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/engine/render/png.ts`:

```ts
/**
 * Minimal PNG decoder for the 8-bit RGB / RGBA, non-interlaced PNGs that
 * Chromium/Playwright screenshots emit. Pure (only `node:zlib`); anything outside
 * that subset throws so the runner can fall back to a needs-review alert. CRC is
 * not validated (screenshots are trusted, locally produced bytes).
 */
import zlib from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf: Buffer): DecodedImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== sig[i]) throw new Error('not a PNG');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len; // 4 length + 4 type + len data + 4 crc
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]!;
    rp += 1;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = raw[rp]!;
      rp += 1;
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      cur[x] = v;
    }
    for (let x = 0; x < width; x += 1) {
      const si = x * channels;
      const di = (y * width + x) * 4;
      out[di] = cur[si]!;
      out[di + 1] = cur[si + 1]!;
      out[di + 2] = cur[si + 2]!;
      out[di + 3] = channels === 4 ? cur[si + 3]! : 255;
    }
    prev = cur;
  }
  return { width, height, rgba: out };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/engine/render/png.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/render/png.ts src/engine/render/png.test.ts
git commit -m "feat(render): vendored 8-bit RGB/RGBA PNG decoder (node:zlib)"
```

---

## Task 5: Worst-case background sampler

**Files:**
- Create: `src/engine/render/sample.ts`
- Test: `src/engine/render/sample.test.ts`

- [ ] **Step 1: Write the failing test** — create `src/engine/render/sample.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleBackground } from './sample.js';
import type { DecodedImage } from './png.js';

function img(pixels: number[][]): DecodedImage {
  const rgba = new Uint8Array(pixels.length * 4);
  pixels.forEach((p, i) => {
    rgba[i * 4] = p[0]!;
    rgba[i * 4 + 1] = p[1]!;
    rgba[i * 4 + 2] = p[2]!;
    rgba[i * 4 + 3] = p[3] ?? 255;
  });
  return { width: pixels.length, height: 1, rgba };
}

test('sampleBackground returns the lowest-contrast background pixel, ignoring text ink', () => {
  // black text pixel (dropped), white bg, mid-grey bg → worst case is the grey.
  const decoded = img([
    [0, 0, 0, 255],       // text ink (near fg) → ignored
    [255, 255, 255, 255], // white bg
    [119, 119, 119, 255], // grey bg (lower contrast vs black)
  ]);
  assert.deepEqual(sampleBackground(decoded, '#000000'), ['rgb(119, 119, 119)']);
});

test('sampleBackground returns [] when every pixel looks like the text color', () => {
  const decoded = img([[10, 10, 10, 255], [12, 12, 12, 255]]);
  assert.deepEqual(sampleBackground(decoded, '#000000'), []);
});

test('sampleBackground skips non-opaque pixels', () => {
  const decoded = img([[255, 255, 255, 0], [119, 119, 119, 255]]);
  assert.deepEqual(sampleBackground(decoded, '#000000'), ['rgb(119, 119, 119)']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/engine/render/sample.test.ts`
Expected: FAIL — `./sample.js` does not exist.

- [ ] **Step 3: Write minimal implementation** — create `src/engine/render/sample.ts`:

```ts
/**
 * Pure worst-case background sampling for text-over-image contrast. Given the
 * decoded pixels of a text run's box and the run's foreground color, drop the
 * glyph-ink and anti-aliased-edge pixels (those close to `fg`) and return the
 * single lowest-contrast remaining background pixel as an opaque `rgb(...)` swatch.
 *
 * Known limitation: separation is by color distance, so when the text color is
 * very close to the background color, the background pixels are dropped too and
 * [] is returned — the caller then defers that run to a needs-review alert rather
 * than guessing. (Color-distant but low-luminance-contrast pairs sample fine.)
 */
import { parseColor } from '../contrast.js';
import type { DecodedImage } from './png.js';

function linear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(r: number, g: number, b: number): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function ratio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export interface SampleOptions {
  /** Manhattan RGB distance to `fg` at/below which a pixel is treated as text/AA-edge. */
  textBand?: number;
}

export function sampleBackground(image: DecodedImage, fg: string, opts: SampleOptions = {}): string[] {
  const textBand = opts.textBand ?? 120;
  const f = parseColor(fg);
  const fgLum = luminance(f.r, f.g, f.b);
  const { width, height, rgba } = image;
  let worst: { r: number; g: number; b: number; ratio: number } | null = null;
  for (let i = 0; i < width * height; i += 1) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const a = rgba[i * 4 + 3]!;
    if (a < 255) continue; // only fully-opaque background pixels
    const dist = Math.abs(f.r - r) + Math.abs(f.g - g) + Math.abs(f.b - b);
    if (dist <= textBand) continue; // glyph ink or its anti-aliased halo
    const rt = ratio(fgLum, luminance(r, g, b));
    if (!worst || rt < worst.ratio) worst = { r, g, b, ratio: rt };
  }
  return worst ? [`rgb(${worst.r}, ${worst.g}, ${worst.b})`] : [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/engine/render/sample.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine/render/sample.ts src/engine/render/sample.test.ts
git commit -m "feat(render): worst-case background swatch sampler"
```

---

## Task 6: Data contract types + pure run-contrast adjudicator

**Files:**
- Modify: `src/engine/render/types.ts` (add `ResolvedBackground`, `TextRun`; keep `TextColorPair` for now)
- Create: `src/engine/render/run-contrast.ts`
- Test: `src/engine/render/run-contrast.test.ts`

- [ ] **Step 1: Add the new types** — append to `src/engine/render/types.ts` (do NOT remove `TextColorPair` or change `ScanResult` yet — that happens in Task 7 to keep the build green):

```ts
/** The resolved background behind a text run, as classified by the runner. */
export type ResolvedBackground =
  | { kind: 'layers'; layers: string[] }       // top→bottom CSS colors down to an opaque base
  | { kind: 'gradient'; css: string }          // raw computed gradient string
  | { kind: 'image'; swatches: string[] }      // worst-case opaque bg samples (rgb strings)
  | { kind: 'unresolvable'; reason: string };  // filters / conic / empty box / screenshot failure

/** One visible text run with its resolved background (replaces TextColorPair). */
export interface TextRun {
  fg: string;
  background: ResolvedBackground;
  size: TextSize;
}
```

- [ ] **Step 2: Write the failing test** — create `src/engine/render/run-contrast.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runContrastIssue } from './run-contrast.js';
import type { TextRun } from './types.js';

const OPTS = { failSeverity: 'blocker' as const, imageFailSeverity: 'warning' as const, gradientSamples: 9 };
const run = (over: Partial<TextRun>): TextRun => ({ fg: '#000000', size: 'normal', background: { kind: 'layers', layers: ['#ffffff'] }, ...over });

test('solid layers: passing pair → null, failing pair → blocker', () => {
  assert.equal(runContrastIssue(run({ fg: '#000000' }), OPTS), null);
  const issue = runContrastIssue(run({ fg: '#999999' }), OPTS);
  assert.equal(issue?.severity, 'blocker');
  assert.equal(issue?.category, 'contrast');
  assert.match(issue?.message ?? '', /2\.85/);
});

test('layers: a 50% black overlay on white is composited before checking', () => {
  // white text on (black@50% over white)=grey(128) → fails → blocker.
  const issue = runContrastIssue(run({ fg: '#ffffff', background: { kind: 'layers', layers: ['rgba(0,0,0,0.5)', 'rgb(255,255,255)'] } }), OPTS);
  assert.equal(issue?.severity, 'blocker');
});

test('gradient: worst-case stop drives the verdict and blocks', () => {
  // black text over a gradient that passes through near-black → worst case fails.
  const issue = runContrastIssue(run({ fg: '#000000', background: { kind: 'gradient', css: 'linear-gradient(90deg, #ffffff, #222222)' } }), OPTS);
  assert.equal(issue?.severity, 'blocker');
  assert.match(issue?.message ?? '', /gradient/i);
});

test('gradient: a uniformly high-contrast gradient passes (null)', () => {
  assert.equal(runContrastIssue(run({ fg: '#000000', background: { kind: 'gradient', css: 'linear-gradient(90deg, #ffffff, #f0f0f0)' } }), OPTS), null);
});

test('image: a failing worst-case swatch is a WARNING by default, with estimate wording', () => {
  const issue = runContrastIssue(run({ fg: '#ffffff', background: { kind: 'image', swatches: ['rgb(240, 240, 240)'] } }), OPTS);
  assert.equal(issue?.severity, 'warning');
  assert.match(issue?.message ?? '', /estimated from rendered pixels/i);
});

test('unresolvable → alert; transparent text → alert', () => {
  assert.equal(runContrastIssue(run({ background: { kind: 'unresolvable', reason: 'css filter' } }), OPTS)?.severity, 'alert');
  assert.equal(runContrastIssue(run({ fg: 'transparent' }), OPTS)?.severity, 'alert');
});

test('unparseable gradient → alert (needs review)', () => {
  assert.equal(runContrastIssue(run({ background: { kind: 'gradient', css: 'conic-gradient(red, blue)' } }), OPTS)?.severity, 'alert');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx --test src/engine/render/run-contrast.test.ts`
Expected: FAIL — `./run-contrast.js` does not exist.

- [ ] **Step 4: Write minimal implementation** — create `src/engine/render/run-contrast.ts`:

```ts
/**
 * Pure contrast adjudicator: one TextRun → an AuditIssue (or null when it passes).
 * Handles every ResolvedBackground kind, reusing engine-core's WCAG math. No DOM,
 * no browser — fully unit-tested with hand-built TextRun fixtures.
 */
import { checkContrast, parseColor, parseColorAlpha, compositeLayers, parseGradientStops } from '../contrast.js';
import { WCAG } from '../../contracts/index.js';
import type { AuditIssue, Severity, TextSize } from '../../contracts/index.js';
import type { ResolvedBackground, TextRun } from './types.js';

const CONTRAST_ID = 'contrast';

export interface RunContrastOptions {
  /** Severity for deterministic (layers/gradient) failures. */
  failSeverity: Severity;
  /** Severity for raster (image) worst-case estimate failures. */
  imageFailSeverity: Severity;
  /** Interpolated samples added between each adjacent gradient stop pair. */
  gradientSamples: number;
}

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function fail(severity: Severity, message: string): AuditIssue {
  return { id: CONTRAST_ID, severity, message, category: 'contrast' };
}
function review(message: string): AuditIssue {
  return { id: CONTRAST_ID, severity: 'alert', message, category: 'contrast' };
}
function minFor(size: TextSize): number {
  return size === 'large' ? WCAG.AA_LARGE : WCAG.AA_NORMAL;
}

/** Lowest-ratio background among candidates (each an opaque CSS color), with fg composited over it. */
function worstAgainst(fg: string, candidates: string[], size: TextSize): { ratio: number; bg: string; passes: boolean } {
  let worst = { ratio: Infinity, bg: candidates[0] ?? 'rgb(255, 255, 255)', passes: true };
  for (const bg of candidates) {
    const fgSolid = compositeLayers([fg, bg]); // composite the (possibly translucent) text over this bg
    const res = checkContrast(fgSolid, bg, size);
    if (res.ratio < worst.ratio) worst = { ratio: res.ratio, bg, passes: res.passesAA };
  }
  return worst;
}

/** Parsed stop colors + interpolated samples; null when no stop parses (e.g. conic). */
function gradientCandidates(css: string, samples: number): string[] | null {
  const parsed: { r: number; g: number; b: number }[] = [];
  for (const token of parseGradientStops(css)) {
    try {
      parsed.push(parseColor(token));
    } catch {
      // direction/angle/shape token or unsupported color — skip
    }
  }
  if (parsed.length === 0) return null;
  if (parsed.length === 1) return [rgb(parsed[0]!.r, parsed[0]!.g, parsed[0]!.b)];
  const out: string[] = [];
  for (let i = 0; i < parsed.length - 1; i += 1) {
    const a = parsed[i]!;
    const b = parsed[i + 1]!;
    out.push(rgb(a.r, a.g, a.b));
    for (let s = 1; s <= samples; s += 1) {
      const t = s / (samples + 1);
      out.push(rgb(Math.round(a.r + (b.r - a.r) * t), Math.round(a.g + (b.g - a.g) * t), Math.round(a.b + (b.b - a.b) * t)));
    }
  }
  const last = parsed[parsed.length - 1]!;
  out.push(rgb(last.r, last.g, last.b));
  return out;
}

export function runContrastIssue(run: TextRun, opts: RunContrastOptions): AuditIssue | null {
  // Fully transparent / unparseable text cannot be adjudicated.
  try {
    if (parseColorAlpha(run.fg).a === 0) return review(`Text color ${run.fg} is fully transparent; manual review needed.`);
  } catch {
    return review(`Text color ${run.fg} could not be parsed; manual review needed.`);
  }

  const bg: ResolvedBackground = run.background;
  switch (bg.kind) {
    case 'layers': {
      let solid: string;
      try {
        solid = compositeLayers(bg.layers);
      } catch {
        return review('Background color could not be resolved; manual review needed.');
      }
      const fgSolid = compositeLayers([run.fg, solid]);
      const res = checkContrast(fgSolid, solid, run.size);
      if (res.passesAA) return null;
      return fail(
        opts.failSeverity,
        `Text contrast ${res.ratio}:1 is below the WCAG AA minimum of ${minFor(run.size)}:1 for ${run.size} text (${run.fg} on ${solid}).`,
      );
    }
    case 'gradient': {
      const candidates = gradientCandidates(bg.css, opts.gradientSamples);
      if (!candidates) return review(`Gradient background "${bg.css}" could not be parsed; manual review needed.`);
      const w = worstAgainst(run.fg, candidates, run.size);
      if (w.passes) return null;
      return fail(
        opts.failSeverity,
        `Worst-case text contrast over the gradient is ${w.ratio}:1, below the WCAG AA minimum of ${minFor(run.size)}:1 for ${run.size} text (${run.fg} on ${w.bg}).`,
      );
    }
    case 'image': {
      if (bg.swatches.length === 0) return review('Background-image contrast could not be sampled; manual review needed.');
      const w = worstAgainst(run.fg, bg.swatches, run.size);
      if (w.passes) return null;
      return fail(
        opts.imageFailSeverity,
        `Worst-case text contrast over the background image is ${w.ratio}:1 (estimated from rendered pixels), below the WCAG AA minimum of ${minFor(run.size)}:1 for ${run.size} text (${run.fg} on ${w.bg}).`,
      );
    }
    case 'unresolvable':
    default:
      return review(`Contrast for ${run.fg} could not be computed (${bg.kind === 'unresolvable' ? bg.reason : 'unknown'}); manual review needed.`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/engine/render/run-contrast.test.ts && npm run typecheck`
Expected: PASS and clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/engine/render/types.ts src/engine/render/run-contrast.ts src/engine/render/run-contrast.test.ts
git commit -m "feat(render): TextRun/ResolvedBackground types + pure contrast adjudicator"
```

---

## Task 7: Migrate the auditor + runner to `textRuns` / run-contrast

**Files:**
- Modify: `src/engine/render/types.ts` (`ScanResult.textPairs` → `textRuns`; remove `TextColorPair`)
- Modify: `src/engine/render/auditor.ts`
- Modify: `src/engine/render/playwright-runner.ts:122-145` (emit `textRuns` as `layers`, interim)
- Modify: `src/engine/render/auditor.test.ts`

- [ ] **Step 1: Update the ScanResult contract** — in `src/engine/render/types.ts`, replace the `TextColorPair` interface and the `textPairs` field. Delete the `TextColorPair` interface entirely and change `ScanResult`:

```ts
/** What a single render-and-scan pass yields for the pure auditor to map. */
export interface ScanResult {
  axe: AxeResults;
  textRuns: TextRun[];
}
```

- [ ] **Step 2: Update the auditor** — replace the body of `src/engine/render/auditor.ts` from the imports through `createAuditor` with:

```ts
import type { AuditIssue, Auditor, IssueSet, Severity } from '../../contracts/index.js';
import type { AxeResult, ScanRunner } from './types.js';
import { semanticCategory, severityForImpact } from './mapping.js';
import { runContrastIssue } from './run-contrast.js';

export interface AuditorOptions {
  /** Severity for deterministic contrast failures (solid/gradient). Default 'blocker'. */
  contrastFailSeverity?: Severity;
  /** Severity for raster (background-image) worst-case estimate failures. Default 'warning'. */
  imageContrastSeverity?: Severity;
  /** Interpolated samples per adjacent gradient stop pair (≈ every 10%). Default 9. */
  gradientSamples?: number;
}

function messageFor(result: AxeResult): string {
  return result.description ?? result.help ?? result.id;
}

export function createAuditor(runner: ScanRunner, options: AuditorOptions = {}): Auditor {
  const failSeverity = options.contrastFailSeverity ?? 'blocker';
  const imageFailSeverity = options.imageContrastSeverity ?? 'warning';
  const gradientSamples = options.gradientSamples ?? 9;

  return async function audit(html: string): Promise<IssueSet> {
    const { axe, textRuns } = await runner.run(html);
    const issues: AuditIssue[] = [];

    // [1] axe violations — impact-driven severity, rule-driven category.
    for (const v of axe.violations) {
      issues.push({
        id: v.id,
        severity: severityForImpact(v.impact),
        message: messageFor(v),
        category: semanticCategory(v.id) ?? 'error',
      });
    }

    // [2] axe incomplete / needs-review — always alert; keep semantic category if any.
    for (const inc of axe.incomplete ?? []) {
      issues.push({
        id: inc.id,
        severity: 'alert',
        message: messageFor(inc),
        category: semanticCategory(inc.id) ?? 'alert',
      });
    }

    // [3] computed-contrast pass (§8.3) — adjudicates solid/gradient/image/unresolvable.
    for (const run of textRuns) {
      const issue = runContrastIssue(run, { failSeverity, imageFailSeverity, gradientSamples });
      if (issue) issues.push(issue);
    }

    return { issues };
  };
}
```

(Remove the old `AuditorOptions`, `CONTRAST_ID`, `contrastIssue`, and the now-unused `WCAG`/`TextColorPair` imports — they now live in `run-contrast.ts`. The threshold/`min` logic moved there too.)

- [ ] **Step 3: Update the runner to emit `textRuns` (interim — solid only)** — in `src/engine/render/playwright-runner.ts`, change the `run()` return so the extracted pairs become `layers` runs. Replace lines 138-140:

```ts
        const rawPairs = (await page.evaluate(EXTRACT_TEXT_PAIRS)) as { fg: string; bg: string; size: TextSize }[];
        const textRuns: TextRun[] = rawPairs.map((p) => ({
          fg: p.fg,
          size: p.size,
          background: { kind: 'layers', layers: [p.bg] },
        }));

        return { axe, textRuns };
```

Update the import on line 15 to bring in `TextRun` and `TextSize`, and drop `TextColorPair`:

```ts
import type { AxeResults, ScanResult, ScanRunner, TextRun } from './types.js';
import type { TextSize } from '../../contracts/index.js';
```

- [ ] **Step 4: Update the auditor tests** — in `src/engine/render/auditor.test.ts`, replace the fake-runner helpers and the contrast-pass tests. Change the import line and helpers:

```ts
import type { AxeImpact, AxeResult, AxeResults, ScanRunner, TextRun } from './types.js';

function fakeRunner(axe: Partial<AxeResults>, textRuns: TextRun[] = []): ScanRunner {
  const base: AxeResults = { violations: [], incomplete: [], passes: [], inapplicable: [] };
  return { run: async () => ({ axe: { ...base, ...axe }, textRuns }) };
}

/** Build a solid-background text run (the common case in these tests). */
function solid(fg: string, bg: string, size: 'normal' | 'large' = 'normal'): TextRun {
  return { fg, size, background: { kind: 'layers', layers: [bg] } };
}

const audit = (axe: Partial<AxeResults>, runs?: TextRun[]) =>
  createAuditor(fakeRunner(axe, runs))('<p>x</p>');
```

Then replace the five contrast-pass tests (the block from `'a fg/bg pair that fails AA …'` through `'contrastFailSeverity option overrides the blocking default'`) with:

```ts
test('a solid pair that fails AA yields a blocking contrast issue by default', async () => {
  const { issues } = await audit({}, [solid('#999999', '#ffffff')]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.id, 'contrast');
  assert.equal(issues[0]?.category, 'contrast');
  assert.equal(issues[0]?.severity, 'blocker');
  assert.match(issues[0]?.message ?? '', /2\.85/);
});

test('a solid pair that passes AA yields no contrast issue', async () => {
  const { issues } = await audit({}, [solid('#666666', '#ffffff'), solid('#000000', '#ffffff')]);
  assert.deepEqual(issues, []);
});

test('contrast verdict is size-driven (large passes where normal fails)', async () => {
  assert.deepEqual((await audit({}, [solid('#808080', '#ffffff', 'large')])).issues, []);
  const normal = await audit({}, [solid('#808080', '#ffffff', 'normal')]);
  assert.equal(normal.issues.length, 1);
  assert.equal(normal.issues[0]?.category, 'contrast');
});

test('an unresolvable run becomes a needs-review alert, never a silent pass', async () => {
  const { issues } = await audit({}, [{ fg: '#000000', size: 'normal', background: { kind: 'unresolvable', reason: 'css filter' } }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, 'alert');
  assert.equal(issues[0]?.category, 'contrast');
});

test('a failing gradient run blocks; a failing image run only warns (severity by certainty)', async () => {
  const grad = await audit({}, [{ fg: '#000000', size: 'normal', background: { kind: 'gradient', css: 'linear-gradient(90deg, #ffffff, #222222)' } }]);
  assert.equal(grad.issues[0]?.severity, 'blocker');

  const image = await audit({}, [{ fg: '#ffffff', size: 'normal', background: { kind: 'image', swatches: ['rgb(240, 240, 240)'] } }]);
  assert.equal(image.issues[0]?.severity, 'warning');
});

test('contrastFailSeverity overrides the deterministic blocking default', async () => {
  const auditor = createAuditor(fakeRunner({}, [solid('#999999', '#ffffff')]), { contrastFailSeverity: 'error' });
  const { issues } = await auditor('<p>x</p>');
  assert.equal(issues[0]?.severity, 'error');
});
```

Finally, in the `'violations, incompletes and contrast failures combine…'` test, change its third argument from `[{ fg: '#999999', bg: '#ffffff', size: 'normal' }]` to `[solid('#999999', '#ffffff')]`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx tsx --test src/engine/render/auditor.test.ts && npm run typecheck`
Expected: PASS, clean typecheck (no remaining `TextColorPair` references anywhere).

- [ ] **Step 6: Run the whole suite to confirm nothing else broke**

Run: `npm test`
Expected: PASS (browser integration stays skipped).

- [ ] **Step 7: Commit**

```bash
git add src/engine/render/types.ts src/engine/render/auditor.ts src/engine/render/auditor.test.ts src/engine/render/playwright-runner.ts
git commit -m "refactor(render): auditor consumes TextRun via the pure contrast adjudicator"
```

---

## Task 8: Real background classification in the Playwright runner

**Files:**
- Modify: `src/engine/render/playwright-runner.ts`
- Test: `src/engine/render/integration.test.ts` (env-gated, real Chromium)

This task is browser-side; it is verified by the env-gated integration test, not pure unit tests.

- [ ] **Step 1: Write the failing (gated) integration tests** — append to `src/engine/render/integration.test.ts`:

```ts
test('text over a low-contrast gradient is flagged as a contrast blocker', { skip }, async () => {
  const { issues } = await audit(
    '<div style="background:linear-gradient(90deg,#ffffff,#f2f2f2);color:#dddddd">faint on gradient</div>',
  );
  assert.ok(
    issues.some((i) => i.category === 'contrast' && i.severity === 'blocker'),
    `expected a gradient contrast blocker, got: ${JSON.stringify(issues)}`,
  );
});

test('text over a translucent overlay is composited and flagged', { skip }, async () => {
  const { issues } = await audit(
    '<div style="background:#ffffff"><span style="background:rgba(255,255,255,0.6);color:#bbbbbb">low on overlay</span></div>',
  );
  assert.ok(
    issues.some((i) => i.category === 'contrast'),
    `expected a contrast issue over the overlay, got: ${JSON.stringify(issues)}`,
  );
});

test('text over a background image yields a contrast warning (estimated)', { skip }, async () => {
  // Solid-black SVG background image; dark-grey text (#333) is COLOR-distant from black
  // (so the sampler keeps the black bg) yet LOW-contrast against it → estimated warning.
  // (A near-same-color pair, e.g. white-on-white, would correctly defer to an alert
  // instead — the sampler can't separate glyph from background then.)
  const bg =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Crect width='100%25' height='100%25' fill='%23000000'/%3E%3C/svg%3E\")";
  const { issues } = await audit(
    `<div style="background-image:${bg};background-size:cover;color:#333333;padding:40px">hero text</div>`,
  );
  assert.ok(
    issues.some((i) => i.category === 'contrast' && i.severity === 'warning'),
    `expected an estimated image contrast warning, got: ${JSON.stringify(issues)}`,
  );
});
```

- [ ] **Step 2: Run to verify they fail** (requires Chromium)

Run: `npx playwright install chromium && RUN_BROWSER_INTEGRATION=1 npx tsx --test src/engine/render/integration.test.ts`
Expected: the three new tests FAIL — the runner still emits every background as `layers`, so gradients/overlays/images are not adjudicated as designed (gradient not flagged as blocker via stops; image not a warning).

- [ ] **Step 3: Replace the in-page extractor + add Node-side sampling** — in `src/engine/render/playwright-runner.ts`:

(a) Update imports (top of file):

```ts
import type { AxeResults, ScanResult, ScanRunner, TextRun, ResolvedBackground } from './types.js';
import type { TextSize } from '../../contracts/index.js';
import { decodePng } from './png.js';
import { sampleBackground } from './sample.js';
```

(b) Replace the `EXTRACT_TEXT_PAIRS` constant (lines ~69-109) with `EXTRACT_TEXT_RUNS`:

```ts
/**
 * Browser-side classifier (§8.3 / Appendix K.5). For each visible text run, resolve
 * the foreground color and classify the background: a solid `layers` stack, a
 * `gradient` (raw css), an `image` (with the run's box rect for screenshotting), or
 * `unresolvable` (CSS filters / conic gradients). Runs as a string — the project's
 * tsconfig has no DOM lib. Exported so the dev-only WAVE oracle can reuse it.
 */
export const EXTRACT_TEXT_RUNS = `(() => {
  const PX_LARGE = 24;          // ~18pt
  const PX_LARGE_BOLD = 18.66;  // ~14pt bold
  const seen = new Set();
  const runs = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue;
    if (!text || !text.trim()) continue;
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
    if (parseFloat(cs.opacity || '1') === 0) continue;
    const fg = cs.color;
    const fontSize = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const isBold = weight >= 700 || cs.fontWeight === 'bold';
    const size = (fontSize >= PX_LARGE || (isBold && fontSize >= PX_LARGE_BOLD)) ? 'large' : 'normal';

    let bg = null;
    let unresolved = null;
    const layers = [];
    let cur = el;
    while (cur) {
      const ccs = getComputedStyle(cur);
      if ((ccs.filter && ccs.filter !== 'none') || (ccs.backdropFilter && ccs.backdropFilter !== 'none')) {
        unresolved = 'css filter'; break;
      }
      const bi = ccs.backgroundImage;
      if (bi && bi !== 'none') {
        if (/gradient\\(/i.test(bi)) {
          if (/conic-gradient/i.test(bi)) { unresolved = 'conic-gradient'; }
          else { bg = { kind: 'gradient', css: bi }; }
          break;
        }
        if (/url\\(/i.test(bi)) {
          const r = el.getBoundingClientRect();
          bg = { kind: 'image', rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
          break;
        }
      }
      const bc = ccs.backgroundColor;
      if (bc && bc !== 'transparent' && bc !== 'rgba(0, 0, 0, 0)') {
        layers.push(bc);
        const m = /^rgba?\\(([^)]+)\\)$/.exec(bc);
        const parts = m ? m[1].split(',') : null;
        const a = parts && parts.length === 4 ? parseFloat(parts[3]) : 1;
        if (a >= 1) break; // opaque base reached
      }
      cur = cur.parentElement;
    }
    if (!bg) {
      if (unresolved) bg = { kind: 'unresolvable', reason: unresolved };
      else { layers.push('rgb(255, 255, 255)'); bg = { kind: 'layers', layers: layers }; }
    }
    const key = fg + '|' + size + '|' + JSON.stringify(bg);
    if (seen.has(key)) continue;
    seen.add(key);
    runs.push({ fg: fg, size: size, bg: bg });
  }
  return runs;
})()`;
```

(c) Add a clip-clamp helper above `createPlaywrightRunner`:

```ts
type RawRun = { fg: string; size: TextSize; bg: ResolvedBackground | { kind: 'image'; rect: { x: number; y: number; width: number; height: number } } };

/** Clamp a DOM rect to a positive, in-viewport clip box (Playwright requires that). */
function clampClip(rect: { x: number; y: number; width: number; height: number }, vw: number, vh: number) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(Math.ceil(rect.width), vw - x);
  const height = Math.min(Math.ceil(rect.height), vh - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
```

(d) Replace the body of `run()` after the `axe` evaluate (the old `EXTRACT_TEXT_PAIRS` evaluate + interim mapping from Task 7) with the classifier + Node-side sampling:

```ts
        const rawRuns = (await page.evaluate(EXTRACT_TEXT_RUNS)) as RawRun[];
        const viewportHeight = 900;
        const textRuns: TextRun[] = [];
        for (const r of rawRuns) {
          if (r.bg.kind === 'image') {
            const clip = clampClip(r.bg.rect, viewportWidth, viewportHeight);
            if (!clip) {
              textRuns.push({ fg: r.fg, size: r.size, background: { kind: 'unresolvable', reason: 'empty box' } });
              continue;
            }
            try {
              const png = await page.screenshot({ clip });
              const swatches = sampleBackground(decodePng(png), r.fg);
              textRuns.push({
                fg: r.fg,
                size: r.size,
                background: swatches.length ? { kind: 'image', swatches } : { kind: 'unresolvable', reason: 'no background pixels' },
              });
            } catch {
              textRuns.push({ fg: r.fg, size: r.size, background: { kind: 'unresolvable', reason: 'screenshot failed' } });
            }
          } else {
            textRuns.push({ fg: r.fg, size: r.size, background: r.bg as ResolvedBackground });
          }
        }

        return { axe, textRuns };
```

(`viewportHeight` matches the `height: 900` used when creating the context above; keep them in sync.)

- [ ] **Step 4: Run the gated integration tests to verify they pass**

Run: `RUN_BROWSER_INTEGRATION=1 npx tsx --test src/engine/render/integration.test.ts`
Expected: PASS — all original + the three new cases (gradient blocker, overlay contrast issue, image warning).

- [ ] **Step 5: Confirm the offline suite is still green**

Run: `npm test`
Expected: PASS (browser tests skipped; `EXTRACT_TEXT_RUNS` is a string, so no DOM types leak into the build).

- [ ] **Step 6: Commit**

```bash
git add src/engine/render/playwright-runner.ts src/engine/render/integration.test.ts
git commit -m "feat(render): classify gradient/image/filter backgrounds + sample image contrast"
```

---

## Task 9: WAVE oracle harness (dev-only)

**Files:**
- Create: `scripts/wave-oracle.ts`
- Modify: `.gitignore` (ignore oracle output)

This is a developer tool to *measure* parity, not shipped code and not in CI (it needs network + a WAVE key + credits). It navigates Playwright to a public URL, runs the same classifier + adjudicator locally, and diffs against the live WAVE API.

- [ ] **Step 1: Add the script** — create `scripts/wave-oracle.ts`:

```ts
/**
 * Dev-only WAVE oracle. Compares this engine's contrast findings against the live
 * WAVE API on public URLs, to verify "as good as / better than WAVE":
 *   - WAVE and us should AGREE on solid-color contrast.
 *   - We should produce LOCAL-ONLY findings on gradients/images (WAVE skips them).
 *
 * Usage:
 *   WAVE_API_KEY=xxxx npx tsx scripts/wave-oracle.ts https://example.com https://another.test
 *
 * Not run in CI. Output is informational (printed to stdout).
 */
import { chromium } from 'playwright';
import { EXTRACT_TEXT_RUNS } from '../src/engine/render/playwright-runner.js';
import { runContrastIssue } from '../src/engine/render/run-contrast.js';
import { decodePng } from '../src/engine/render/png.js';
import { sampleBackground } from '../src/engine/render/sample.js';
import type { ResolvedBackground, TextRun } from '../src/engine/render/types.js';

const KEY = process.env.WAVE_API_KEY;
const URLS = process.argv.slice(2);

if (!KEY) { console.error('Set WAVE_API_KEY'); process.exit(1); }
if (URLS.length === 0) { console.error('Pass one or more public URLs'); process.exit(1); }

type RawRun = { fg: string; size: 'normal' | 'large'; bg: ResolvedBackground | { kind: 'image'; rect: { x: number; y: number; width: number; height: number } } };

async function localContrastFindings(url: string): Promise<number> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1000);
    const rawRuns = (await page.evaluate(EXTRACT_TEXT_RUNS)) as RawRun[];
    let fails = 0;
    for (const r of rawRuns) {
      let background: ResolvedBackground;
      if (r.bg.kind === 'image') {
        try {
          const clip = { x: Math.max(0, Math.floor(r.bg.rect.x)), y: Math.max(0, Math.floor(r.bg.rect.y)), width: Math.max(1, Math.ceil(r.bg.rect.width)), height: Math.max(1, Math.ceil(r.bg.rect.height)) };
          const swatches = sampleBackground(decodePng(await page.screenshot({ clip })), r.fg);
          background = swatches.length ? { kind: 'image', swatches } : { kind: 'unresolvable', reason: 'no bg pixels' };
        } catch { background = { kind: 'unresolvable', reason: 'screenshot failed' }; }
      } else {
        background = r.bg as ResolvedBackground;
      }
      const run: TextRun = { fg: r.fg, size: r.size, background };
      const issue = runContrastIssue(run, { failSeverity: 'blocker', imageFailSeverity: 'warning', gradientSamples: 9 });
      if (issue && issue.severity !== 'alert') fails += 1;
    }
    return fails;
  } finally {
    await browser.close();
  }
}

async function waveContrastCount(url: string): Promise<number> {
  const api = new URL('https://wave.webaim.org/api/request');
  api.searchParams.set('key', KEY!);
  api.searchParams.set('url', url);
  api.searchParams.set('reporttype', '1');
  const res = await fetch(api);
  const json = (await res.json()) as { categories?: { contrast?: { count?: number } } };
  return json.categories?.contrast?.count ?? 0;
}

for (const url of URLS) {
  const [local, wave] = await Promise.all([localContrastFindings(url), waveContrastCount(url)]);
  const delta = local - wave;
  console.log(`${url}\n  local contrast fails: ${local}\n  WAVE contrast errors: ${wave}\n  delta (local-only, expected ≥0 on gradient/image pages): ${delta}\n`);
}
```

> **Implementer note:** the script reuses the runner's exported `EXTRACT_TEXT_RUNS` classifier (no duplication). It deliberately re-implements the small screenshot/sample glue inline rather than adding a URL mode to the shipped runner.

- [ ] **Step 2: Ignore oracle output** — append to `.gitignore`:

```
# WAVE oracle (dev-only) scratch output
/oracle-out/
```

- [ ] **Step 3: Smoke-check it typechecks**

Run: `npm run typecheck`
Expected: PASS (the script is included by `tsc`; it must compile even though it is never run in CI).

- [ ] **Step 4: (Optional, manual) run against a known page**

Run: `WAVE_API_KEY=<key> npx tsx scripts/wave-oracle.ts https://www.w3.org/WAI/demos/bad/before/home.html`
Expected: prints local vs WAVE contrast counts (informational; needs network + credits).

- [ ] **Step 5: Commit**

```bash
git add scripts/wave-oracle.ts .gitignore
git commit -m "chore(dev): WAVE oracle harness for contrast parity measurement"
```

---

## Final verification

- [ ] Run the full offline suite: `npm test` → all pass, browser integration skipped.
- [ ] Run typecheck: `npm run typecheck` → clean.
- [ ] Run the gated browser suite once: `RUN_BROWSER_INTEGRATION=1 npm test` → contrast adjudication passes end-to-end.
- [ ] Confirm `dependencies` in `package.json` are still only `axe-core` + `playwright` (no new runtime deps).

---

## Spec coverage check (self-review)

- §2 data contract → Task 6 (types) + Task 7 (ScanResult migration). ✓
- §3 declarative resolver (gradients + alpha) → Task 2, Task 3, Task 6 (`gradientCandidates`, `compositeLayers`). ✓
- §4 raster sampler (PNG decode + sample + capture) → Task 4, Task 5, Task 8. ✓
- §5 severity by certainty → Task 6 (`failSeverity` vs `imageFailSeverity`) + Task 7 (`AuditorOptions`). ✓
- §6 precision fix → Task 1. ✓
- §7 oracle harness → Task 9. ✓
- §8 test strategy → pure tests in Tasks 1-6; auditor tests Task 7; env-gated integration Task 8. ✓
- §1 "unresolvable still defers to alert" → Task 6 (`unresolvable`/transparent/unparseable → `review`). ✓

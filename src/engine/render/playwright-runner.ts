/**
 * The real `ScanRunner`: render a fragment in headless Chromium and produce the
 * raw inputs the pure auditor maps (PRD §8.2, §8.6, Appendix K.5).
 *
 * EVERYTHING browser-related lives here and is reached only when `run()` is
 * actually called. `playwright` and `axe-core` are loaded via dynamic `import()`
 * *inside* `run()`, and the Chromium binary is launched only then — so importing
 * this module (or `index.ts`, which wires `audit`) never touches a browser. That
 * keeps `npm test` fully offline; the one real-browser test is env-gated.
 *
 * To exercise it you need a Chromium binary:
 *   npx playwright install chromium      # or point launchOptions.executablePath
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LaunchOptions } from 'playwright';
import type { AxeResults, ImageAlt, ScanResult, ScanRunner, TextRun, ResolvedBackground } from './types.js';
import type { TextSize } from '../../contracts/index.js';
import { decodePng } from './png.js';
import { sampleBackground } from './sample.js';
import { wrapInCanvasShell } from './canvas-shell.js';

export interface PlaywrightRunnerOptions {
  /** Render viewport width in px (Appendix K.5 default: 1200). `RENDER_VIEWPORT_WIDTH`. */
  viewportWidth?: number;
  /** Render viewport height in px (default 900). `RENDER_VIEWPORT_HEIGHT`. */
  viewportHeight?: number;
  /** Settle delay (ms) after load before scanning (Appendix K.5 default: 1000). `RENDER_SETTLE_DELAY_MS`. */
  settleDelayMs?: number;
  /** Extra Chromium launch options (e.g. `executablePath`, `channel`, `headless`). */
  launchOptions?: LaunchOptions;
}

/**
 * axe tags scanned (PRD §8.2): WCAG Level A + AA across 2.0, 2.1 AND 2.2 — the
 * product targets WCAG 2.2 AA. Adding `wcag21a` (2.1 Level A, e.g. status messages)
 * and `wcag22aa` (2.2 AA, e.g. 2.5.8 target-size) closes a coverage gap where rules
 * tagged only for those versions were never run. axe-core 4.12 has no `wcag22a`
 * tag (2.2 added no automatable Level A rules). `best-practice`/AAA are deliberately
 * excluded — they are not WCAG 2.2 AA failures and would manufacture false blockers.
 */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Rules switched on explicitly, overriding the tag filter above. Two gaps found
 * by auditing 8 real Canvas course exports (314 pages), where axe reported ZERO
 * heading and table failures on content that plainly has them.
 *
 * `td-has-header` — a data table whose header row is `<td>` (no `<th>` anywhere)
 *   makes its relationships programmatically undeterminable. axe tags this
 *   `wcag2a` + `wcag131`, i.e. a definite AA failure — but ALSO `experimental`,
 *   and axe does not run experimental rules unless asked. So the rule we needed
 *   already existed and was simply off. Impact `critical` → `blocker`, which
 *   withholds the badge — correct for a definite 1.3.1 failure. Verified across
 *   314 real pages: fires on 3 (eng-101's timetable and grading rubric among
 *   them) and stays silent on all 18 Moodle `forumpost` LAYOUT tables — axe's
 *   own data-vs-layout heuristic gets that right, which is the hard part, and
 *   the reason not to hand-roll this.
 *
 * `heading-order` — a skipped heading level (H1 → H4). axe tags this
 *   `best-practice`, NOT wcag: skipping levels is discouraged but is not
 *   formally an AA failure, and this file deliberately excludes best-practice
 *   to avoid manufacturing false blockers. Enabling it does not break that
 *   promise: impact `moderate` → `warning`, which is SURFACED but does NOT
 *   withhold the badge — the same weight WAVE gives it ("Alert"). We report what
 *   a human should look at without claiming a conformance failure we cannot
 *   substantiate. Fires on 9 of the 314 real pages, matching a hand-written
 *   heading-skip labeller independently, on the same 9 pages.
 *
 * Both are opt-ins, not tag changes: widening AXE_TAGS to `best-practice` would
 * drag in dozens of unrelated non-WCAG rules.
 */
export const AXE_RULE_OVERRIDES: Readonly<Record<string, { enabled: boolean }>> = {
  'td-has-header': { enabled: true },
  'heading-order': { enabled: true },
};

/**
 * Resolve the Chromium browser bundle shipped INSIDE the packaged `.app`.
 *
 * The product's core guarantee — the unconditional accessibility gate — depends on
 * a real headless Chromium. In dev, `npx playwright install chromium` populates the
 * global `~/.cache/ms-playwright` (or `%LOCALAPPDATA%`) cache and `chromium.launch()`
 * finds it. A packaged DMG carries no such cache, so without this the gate would
 * fail-closed on every turn. electron-builder bundles the browser under
 * `<resources>/ms-playwright` (see `build.extraResources`); pointing
 * `PLAYWRIGHT_BROWSERS_PATH` at that dir makes `chromium.launch()` resolve the
 * bundled binary (playwright knows its own revision/nesting).
 *
 * Returns the bundled dir only when it actually exists. In dev/test (no
 * `process.resourcesPath`, or the dir absent) it returns `undefined` so playwright
 * falls back to its normal cache — dev behavior is unchanged. Pure + injectable so
 * it is unit-tested without a filesystem or a packaged app.
 */
export function resolveBundledBrowsersPath(
  resourcesPath: string | undefined = (process as { resourcesPath?: string }).resourcesPath,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  if (!resourcesPath) return undefined;
  const dir = path.join(resourcesPath, 'ms-playwright');
  return exists(dir) ? dir : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Every image and its alt text, for the alt-quality pass (`altTextIssue`).
 *
 * Reads the attribute, not the IDL property: `img.alt` returns `''` for BOTH a
 * missing attribute and `alt=""`, which collapses "no text alternative" (an axe
 * error) into "explicitly decorative" (correct) — the one distinction this pass
 * exists to make.
 *
 * `presentation` walks the ANCESTOR chain, not just the img: an image inside an
 * `aria-hidden` or `role="presentation"` wrapper is removed from the
 * accessibility tree just as surely as one marked directly, and judging alt text
 * a screen reader will never announce would be a false positive.
 *
 * Runs as a string; the project's tsconfig has no DOM lib.
 */
export const EXTRACT_IMAGES = `(() => {
  const decorative = (node) => {
    for (let cur = node; cur; cur = cur.parentElement) {
      const role = (cur.getAttribute('role') || '').toLowerCase();
      if (role === 'presentation' || role === 'none') return true;
      if (cur.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  };
  return Array.from(document.querySelectorAll('img')).map((el) => ({
    alt: el.hasAttribute('alt') ? el.getAttribute('alt') : null,
    src: el.getAttribute('src') || '',
    presentation: decorative(el),
  }));
})()`;

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
          // Capture the TEXT element's box (el), not the image-bearing ancestor (cur):
          // contrast is checked against the pixels behind the text itself.
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

/** Raw image background as returned from the browser (rect, not swatches). */
type RawImageBg = { kind: 'image'; rect: { x: number; y: number; width: number; height: number } };
type RawRun = { fg: string; size: TextSize; bg: Exclude<ResolvedBackground, { kind: 'image' }> | RawImageBg };

/** Clamp a DOM rect to a positive, in-viewport clip box (Playwright requires that). */
function clampClip(rect: { x: number; y: number; width: number; height: number }, vw: number, vh: number) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const width = Math.min(Math.ceil(rect.width), vw - x);
  const height = Math.min(Math.ceil(rect.height), vh - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Build a Chromium-backed `ScanRunner`. One browser is launched per `run()` and
 * always closed; a single fragment is small, so per-call launch keeps the runner
 * stateless and leak-free (the orchestrator scans one fragment at a time).
 */
export function createPlaywrightRunner(options: PlaywrightRunnerOptions = {}): ScanRunner {
  const viewportWidth = options.viewportWidth ?? envInt('RENDER_VIEWPORT_WIDTH', 1200);
  const viewportHeight = options.viewportHeight ?? envInt('RENDER_VIEWPORT_HEIGHT', 900);
  const settleDelayMs = options.settleDelayMs ?? envInt('RENDER_SETTLE_DELAY_MS', 1000);
  const launchOptions = options.launchOptions ?? {};

  return {
    async run(html: string): Promise<ScanResult> {
      // When packaged, point playwright at the bundled Chromium BEFORE it loads, so
      // `chromium.launch()` resolves the in-`.app` browser instead of a dev-only
      // global cache that a DMG does not carry. No-op in dev/test or when the caller
      // pinned an explicit `executablePath`. (PLAYWRIGHT_BROWSERS_PATH already set by
      // the environment wins.)
      if (!launchOptions.executablePath && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
        const bundled = resolveBundledBrowsersPath();
        if (bundled) process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
      }

      const { chromium } = await import('playwright');
      const axeSource = (await import('axe-core')).default.source;

      // Use the open-source **chromium-headless-shell** (BSD) rather than the full
      // "Chrome for Testing" build. The auditor only needs headless rendering +
      // screenshots, and the shell carries no Widevine CDM (proprietary DRM we may
      // not redistribute) or Google-proprietary Chrome-for-Testing bits — and it is
      // ~340MB smaller. Skipped when a caller pins an explicit `executablePath`
      // (e.g. a test binary); `launchOptions` still overrides everything.
      const browser = await chromium.launch({
        headless: true,
        ...(launchOptions.executablePath ? {} : { channel: 'chromium-headless-shell' }),
        ...launchOptions,
      });
      try {
        const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight } });
        const page = await context.newPage();
        await page.setContent(wrapInCanvasShell(html), { waitUntil: 'load' });
        if (settleDelayMs > 0) await page.waitForTimeout(settleDelayMs);

        await page.addScriptTag({ content: axeSource });
        const axeExpr =
          `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(AXE_TAGS)} }, ` +
          `rules: ${JSON.stringify(AXE_RULE_OVERRIDES)}, ` +
          `resultTypes: ['violations', 'incomplete'] })`;
        const axe = (await page.evaluate(axeExpr)) as AxeResults;
        const images = (await page.evaluate(EXTRACT_IMAGES)) as ImageAlt[];
        const rawRuns = (await page.evaluate(EXTRACT_TEXT_RUNS)) as RawRun[];
        const textRuns: TextRun[] = [];
        for (const r of rawRuns) {
          if (r.bg.kind === 'image' && 'rect' in r.bg) {
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

        return { axe, textRuns, images };
      } finally {
        await browser.close();
      }
    },
  };
}

/** Default Chromium-backed runner used by the exported `audit`. */
export const playwrightRunner: ScanRunner = createPlaywrightRunner();

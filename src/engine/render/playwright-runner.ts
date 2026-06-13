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
import type { LaunchOptions } from 'playwright';
import type { AxeResults, ScanResult, ScanRunner, TextRun, ResolvedBackground } from './types.js';
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

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

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
      const { chromium } = await import('playwright');
      const axeSource = (await import('axe-core')).default.source;

      const browser = await chromium.launch({ headless: true, ...launchOptions });
      try {
        const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight } });
        const page = await context.newPage();
        await page.setContent(wrapInCanvasShell(html), { waitUntil: 'load' });
        if (settleDelayMs > 0) await page.waitForTimeout(settleDelayMs);

        await page.addScriptTag({ content: axeSource });
        const axeExpr =
          `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(AXE_TAGS)} }, ` +
          `resultTypes: ['violations', 'incomplete'] })`;
        const axe = (await page.evaluate(axeExpr)) as AxeResults;
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

        return { axe, textRuns };
      } finally {
        await browser.close();
      }
    },
  };
}

/** Default Chromium-backed runner used by the exported `audit`. */
export const playwrightRunner: ScanRunner = createPlaywrightRunner();

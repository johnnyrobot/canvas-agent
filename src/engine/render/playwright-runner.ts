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
import type { AxeResults, ScanResult, ScanRunner, TextColorPair } from './types.js';

export interface PlaywrightRunnerOptions {
  /** Render viewport width in px (Appendix K.5 default: 1200). `RENDER_VIEWPORT_WIDTH`. */
  viewportWidth?: number;
  /** Settle delay (ms) after load before scanning (Appendix K.5 default: 1000). `RENDER_SETTLE_DELAY_MS`. */
  settleDelayMs?: number;
  /** Extra Chromium launch options (e.g. `executablePath`, `channel`, `headless`). */
  launchOptions?: LaunchOptions;
}

/** axe tags scanned (PRD §8.2): WCAG 2.0/2.1 A + AA. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Wrap a Canvas content fragment in a minimal "Canvas-like" shell so computed
 * styles (and thus contrast) approximate what students see, rather than a bare
 * fragment on a default UA sheet (PRD §8.6). Animations are disabled for
 * deterministic, reproducible scans.
 */
function canvasShell(fragment: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<style>',
    '*,*::before,*::after{animation:none !important;transition:none !important;}',
    'body{margin:0;padding:16px;background:#ffffff;color:#2d3b45;',
    'font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;}',
    '</style></head>',
    `<body><div id="content">${fragment}</div></body></html>`,
  ].join('');
}

/**
 * Browser-side text/background color extractor (Appendix K.5 / §8.3). Runs in the
 * page as a string (the project's tsconfig has no DOM lib), walking visible text
 * runs and resolving each run's computed foreground and effective background.
 * Gradients / semi-transparent overlays are left for the contrast pass to route
 * to manual review.
 */
const EXTRACT_TEXT_PAIRS = `(() => {
  const PX_LARGE = 24;          // ~18pt
  const PX_LARGE_BOLD = 18.66;  // ~14pt bold
  const seen = new Set();
  const pairs = [];
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
    let bg = 'rgb(255, 255, 255)';
    let cur = el;
    while (cur) {
      const bc = getComputedStyle(cur).backgroundColor;
      if (bc && bc !== 'transparent') {
        const m = /^rgba?\\(([^)]+)\\)$/.exec(bc);
        if (m) {
          const parts = m[1].split(',').map((s) => s.trim());
          const a = parts.length === 4 ? parseFloat(parts[3]) : 1;
          if (a > 0) { bg = bc; break; }
        } else { bg = bc; break; }
      }
      cur = cur.parentElement;
    }
    const fontSize = parseFloat(cs.fontSize) || 16;
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const isBold = weight >= 700 || cs.fontWeight === 'bold';
    const size = (fontSize >= PX_LARGE || (isBold && fontSize >= PX_LARGE_BOLD)) ? 'large' : 'normal';
    const key = fg + '|' + bg + '|' + size;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ fg: fg, bg: bg, size: size });
  }
  return pairs;
})()`;

/**
 * Build a Chromium-backed `ScanRunner`. One browser is launched per `run()` and
 * always closed; a single fragment is small, so per-call launch keeps the runner
 * stateless and leak-free (the orchestrator scans one fragment at a time).
 */
export function createPlaywrightRunner(options: PlaywrightRunnerOptions = {}): ScanRunner {
  const viewportWidth = options.viewportWidth ?? envInt('RENDER_VIEWPORT_WIDTH', 1200);
  const settleDelayMs = options.settleDelayMs ?? envInt('RENDER_SETTLE_DELAY_MS', 1000);
  const launchOptions = options.launchOptions ?? {};

  return {
    async run(html: string): Promise<ScanResult> {
      const { chromium } = await import('playwright');
      const axeSource = (await import('axe-core')).default.source;

      const browser = await chromium.launch({ headless: true, ...launchOptions });
      try {
        const context = await browser.newContext({ viewport: { width: viewportWidth, height: 900 } });
        const page = await context.newPage();
        await page.setContent(canvasShell(html), { waitUntil: 'load' });
        if (settleDelayMs > 0) await page.waitForTimeout(settleDelayMs);

        await page.addScriptTag({ content: axeSource });
        const axeExpr =
          `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(AXE_TAGS)} }, ` +
          `resultTypes: ['violations', 'incomplete'] })`;
        const axe = (await page.evaluate(axeExpr)) as AxeResults;
        const textPairs = (await page.evaluate(EXTRACT_TEXT_PAIRS)) as TextColorPair[];

        return { axe, textPairs };
      } finally {
        await browser.close();
      }
    },
  };
}

/** Default Chromium-backed runner used by the exported `audit`. */
export const playwrightRunner: ScanRunner = createPlaywrightRunner();

/**
 * HTML → PNG rendering for the model-eval harness.
 *
 * Renders each fixture's full standalone HTML document to a full-page PNG on
 * disk, so a vision model can be shown the same pixels a human reviewer would
 * see. There is no existing HTML-string→PNG-on-disk path in the codebase
 * (see `.frugal-fable/eval-spec/canvas-agent-surfaces.md` §A.4) — every
 * existing `page.screenshot()` call is an in-memory clip fed to the repo's
 * hand-rolled PNG decoder (`src/engine/render/png.ts`), never written to
 * disk. This module adds that path, following the exact
 * launch/context/page/screenshot pattern already used by
 * `src/engine/render/playwright-runner.ts` and `scripts/wave-oracle.ts`.
 *
 * Reuses `resolveBundledBrowsersPath` so this works both in dev (Playwright's
 * global cache) and inside a packaged Electron app (bundled Chromium under
 * `<resources>/ms-playwright`) — do not reinvent that resolution here.
 *
 *   npx tsx scripts/model-eval/render.ts   (not a CLI entrypoint by itself;
 *   import `renderFixtures` / `renderHtmlToPng` from an eval driver script)
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser } from 'playwright';
import { resolveBundledBrowsersPath } from '../../src/engine/render/playwright-runner.js';
import type { Fixture, RenderedFixture } from './types.js';

const VIEWPORT = { width: 1280, height: 1024 };
const DEVICE_SCALE_FACTOR = 2;

/** Disables animations/transitions so full-page screenshots are deterministic. */
const NO_MOTION_CSS = '*,*::before,*::after{animation:none !important;transition:none !important;}';

/**
 * Launch headless Chromium, resolving the bundled-vs-dev executable exactly
 * as `playwright-runner.ts` does: point `PLAYWRIGHT_BROWSERS_PATH` at the
 * packaged `<resources>/ms-playwright` dir when running inside a packaged
 * Electron app (no-op in dev/CLI, where `process.resourcesPath` is unset).
 */
async function launchChromium(): Promise<Browser> {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    const bundled = resolveBundledBrowsersPath();
    if (bundled) process.env.PLAYWRIGHT_BROWSERS_PATH = bundled;
  }
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true, channel: 'chromium-headless-shell' });
}

/** Render one HTML document to a full-page PNG using an already-launched browser. */
async function screenshotOne(browser: Browser, html: string, outPath: string): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
  try {
    const page = await context.newPage();
    // setContent, not goto/data-URL: this is the load path the real auditor
    // uses (playwright-runner.ts:205), and fixtures are already full documents.
    await page.setContent(html, { waitUntil: 'load' });
    await page.addStyleTag({ content: NO_MOTION_CSS });
    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await context.close();
  }
}

/**
 * Render a batch of fixtures to `outDir/<fixture.id>.png`. Chromium is
 * launched once for the whole batch (not per fixture) and always closed.
 */
export async function renderFixtures(fixtures: Fixture[], outDir: string): Promise<RenderedFixture[]> {
  await mkdir(outDir, { recursive: true });
  const browser = await launchChromium();
  try {
    const rendered: RenderedFixture[] = [];
    for (const fixture of fixtures) {
      const pngPath = path.join(outDir, `${fixture.id}.png`);
      await screenshotOne(browser, fixture.html, pngPath);
      rendered.push({ ...fixture, pngPath });
    }
    return rendered;
  } finally {
    await browser.close();
  }
}

/** Render a single HTML string to a full-page PNG at `outPath`. Returns `outPath`. */
export async function renderHtmlToPng(html: string, outPath: string): Promise<string> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const browser = await launchChromium();
  try {
    await screenshotOne(browser, html, outPath);
    return outPath;
  } finally {
    await browser.close();
  }
}

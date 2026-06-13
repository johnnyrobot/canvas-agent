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

const KEY = process.env['WAVE_API_KEY'];
const URLS = process.argv.slice(2);

type RawImageBg = { kind: 'image'; rect: { x: number; y: number; width: number; height: number } };
type RawRun = { fg: string; size: 'normal' | 'large'; bg: Exclude<ResolvedBackground, { kind: 'image' }> | RawImageBg };

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
      if (r.bg.kind === 'image' && 'rect' in r.bg) {
        try {
          const rect = r.bg.rect;
          const clip = {
            x: Math.max(0, Math.floor(rect.x)),
            y: Math.max(0, Math.floor(rect.y)),
            width: Math.max(1, Math.ceil(rect.width)),
            height: Math.max(1, Math.ceil(rect.height)),
          };
          const swatches = sampleBackground(decodePng(await page.screenshot({ clip })), r.fg);
          background = swatches.length ? { kind: 'image', swatches } : { kind: 'unresolvable', reason: 'no bg pixels' };
        } catch {
          background = { kind: 'unresolvable', reason: 'screenshot failed' };
        }
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

async function main(): Promise<void> {
  if (!KEY) { console.error('Set WAVE_API_KEY'); process.exit(1); }
  if (URLS.length === 0) { console.error('Pass one or more public URLs'); process.exit(1); }
  for (const url of URLS) {
    const [local, wave] = await Promise.all([localContrastFindings(url), waveContrastCount(url)]);
    const delta = local - wave;
    console.log(`${url}\n  local contrast fails: ${local}\n  WAVE contrast errors: ${wave}\n  delta (local-only, expected >=0 on gradient/image pages): ${delta}\n`);
  }
}

void main();

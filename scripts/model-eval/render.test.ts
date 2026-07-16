/**
 * Integration test for `renderHtmlToPng` against real headless Chromium.
 *
 * Skipped by default so `npm test` stays green offline with NO browser
 * download. Mirrors the gated convention in
 * `src/engine/render/integration.test.ts` / `e2e/renderer-a11y.test.ts`. To run:
 *   npx playwright install chromium-headless-shell
 *   RUN_BROWSER_INTEGRATION=1 npx tsx --test scripts/model-eval/render.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderHtmlToPng } from './render.js';

const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes'].includes((v ?? '').toLowerCase());
const optedIn = truthy(process.env.RUN_BROWSER_INTEGRATION);
const skip: true | string | false = optedIn ? false : 'set RUN_BROWSER_INTEGRATION=1 to run';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('renderHtmlToPng writes a full-page PNG to the expected path', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'render-test-'));
  try {
    const outPath = path.join(dir, 'trivial.png');
    const html = '<!DOCTYPE html><html><head><title>t</title></head>' +
      '<body><h1>Hello</h1><p>A trivial fixture for the render test.</p></body></html>';

    const returned = await renderHtmlToPng(html, outPath);
    assert.equal(returned, outPath);

    const bytes = await readFile(outPath);
    assert.ok(bytes.subarray(0, 4).equals(PNG_MAGIC), 'output does not start with the PNG magic bytes');
    assert.ok(bytes.length > 1000, `expected a non-trivial PNG, got ${bytes.length} bytes`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Integration test for the REAL render-and-scan path against headless Chromium.
 *
 * Skipped by default so `npm test` stays green offline with NO browser download.
 * To run:  npx playwright install chromium
 *          RUN_BROWSER_INTEGRATION=1 npm test
 * (or point a binary via PLAYWRIGHT chromium channel/executablePath).
 *
 * Mirrors the gated live-Ollama integration tests in src/llm/integration.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuditor, createPlaywrightRunner } from './index.js';

const optedIn = ['1', 'true', 'yes'].includes((process.env.RUN_BROWSER_INTEGRATION ?? '').toLowerCase());
const skip: true | string | false = optedIn ? false : 'set RUN_BROWSER_INTEGRATION=1 to run';

// Small settle delay keeps the gated run fast; the fragment loads no network.
const audit = createAuditor(createPlaywrightRunner({ settleDelayMs: 50 }));

test('a meaningful <img> with no alt yields an image-alt issue', { skip }, async () => {
  const { issues } = await audit('<p>Hello</p><img src="https://example.com/x.png">');
  assert.ok(
    issues.some((i) => i.id === 'image-alt'),
    `expected an image-alt issue, got: ${JSON.stringify(issues)}`,
  );
});

test('a low-contrast text run yields a computed-contrast issue', { skip }, async () => {
  const { issues } = await audit('<p style="color:#999999;background:#ffffff">faint text</p>');
  assert.ok(
    issues.some((i) => i.category === 'contrast'),
    `expected a contrast issue, got: ${JSON.stringify(issues)}`,
  );
});

test('a clean, accessible fragment produces no blockers', { skip }, async () => {
  const { issues } = await audit('<h2>Title</h2><p>Readable, sufficient-contrast body text.</p>');
  assert.equal(
    issues.filter((i) => i.severity === 'blocker').length,
    0,
    `expected no blockers, got: ${JSON.stringify(issues)}`,
  );
});

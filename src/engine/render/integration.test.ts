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

// ── Rules enabled over axe's defaults (see AXE_RULE_OVERRIDES) ───────────────
// Both were found by auditing 8 real Canvas exports, where axe reported ZERO
// heading and table failures on content that plainly has them.

test('a data table whose header row is <td> is a blocker (axe td-has-header, experimental → opted in)', { skip }, async () => {
  const { issues } = await audit(
    '<table>' +
      '<tr><td>Week</td><td>Topic</td><td>Reading</td></tr>' +
      '<tr><td>1</td><td>Cells</td><td>Ch. 1</td></tr>' +
      '<tr><td>2</td><td>Genetics</td><td>Ch. 2</td></tr>' +
      '</table>',
  );
  const found = issues.find((i) => i.id === 'td-has-header');
  assert.ok(found, 'a header-less data table must be reported — this is a WCAG 1.3.1 failure axe ships DISABLED');
  assert.equal(found.severity, 'blocker', 'definite 1.3.1 failure: must withhold the passed-checks badge');
});

test('a properly headed data table is silent', { skip }, async () => {
  const { issues } = await audit(
    '<table>' +
      '<thead><tr><th scope="col">Week</th><th scope="col">Topic</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>Cells</td></tr><tr><td>2</td><td>Genetics</td></tr></tbody>' +
      '</table>',
  );
  assert.equal(issues.filter((i) => i.id === 'td-has-header').length, 0);
});

test('a skipped heading level is a WARNING, not a blocker (axe heading-order, best-practice → opted in)', { skip }, async () => {
  const { issues } = await audit('<h1>Syllabus</h1><h4>Week 1</h4><p>Intro.</p>');
  const found = issues.find((i) => i.id === 'heading-order');
  assert.ok(found, 'H1 -> H4 skips a level and must be surfaced');
  // Deliberate: axe tags heading-order `best-practice`, NOT wcag. Skipping levels
  // is discouraged but is not formally an AA failure, so we surface it the way
  // WAVE does (an "Alert") rather than claim a conformance failure we cannot
  // substantiate. `warning` does not withhold the badge.
  assert.equal(found.severity, 'warning');
});

test('a correctly ordered heading sequence is silent', { skip }, async () => {
  const { issues } = await audit('<h1>Syllabus</h1><h2>Week 1</h2><h3>Readings</h3>');
  assert.equal(issues.filter((i) => i.id === 'heading-order').length, 0);
});

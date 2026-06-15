import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AXE_TAGS, resolveBundledBrowsersPath } from './playwright-runner.js';

// Browser-free: asserts the COVERAGE CLAIM encoded in the axe tag set. The product
// states WCAG 2.2 AA; axe-core 4.12 tags rules by version+level, so the scan must
// run the Level A + AA umbrella tags across 2.0, 2.1 AND 2.2 — otherwise the
// "passed checks" badge and coverage banner overstate what was actually checked.
test('axe runs the full WCAG A+AA rule set through WCAG 2.2 (coverage claim)', () => {
  for (const tag of ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']) {
    assert.ok(AXE_TAGS.includes(tag), `AXE_TAGS must include "${tag}" to back the WCAG 2.2 AA claim`);
  }
});

test('axe excludes best-practice and AAA rules (only definite WCAG A/AA failures gate)', () => {
  // best-practice and AAA rules are not WCAG 2.2 AA failures; running them would
  // manufacture false "failures" and dishonestly withhold the badge.
  assert.ok(!AXE_TAGS.includes('best-practice'), 'best-practice rules are not WCAG conformance failures');
  assert.ok(!AXE_TAGS.includes('wcag2aaa'), 'AAA is above the AA conformance target');
});

// ── Packaged-Chromium resolution (the gate must launch a real browser in the .app) ──

test('resolveBundledBrowsersPath points at <resources>/ms-playwright when it exists (packaged)', () => {
  const resources = '/Applications/Canvas Agent.app/Contents/Resources';
  const expected = path.join(resources, 'ms-playwright');
  const got = resolveBundledBrowsersPath(resources, (p) => p === expected);
  assert.equal(got, expected, 'packaged app must resolve its bundled Chromium, not a dev cache');
});

test('resolveBundledBrowsersPath is undefined in dev/test (no resourcesPath or dir absent)', () => {
  // No resourcesPath (plain node/tsx) → fall back to playwright default cache.
  assert.equal(resolveBundledBrowsersPath(undefined, () => true), undefined);
  // resourcesPath present but nothing bundled (dev electron) → default cache.
  assert.equal(resolveBundledBrowsersPath('/some/Resources', () => false), undefined);
});

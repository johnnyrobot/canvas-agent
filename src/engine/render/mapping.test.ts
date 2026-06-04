/**
 * Unit tests for the pure axe→IssueSet mapping helpers (offline, no browser).
 * Strict TDD: these are written before the implementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { severityForImpact, semanticCategory, DEFAULT_VIOLATION_SEVERITY } from './mapping.js';

test('severityForImpact maps each axe impact per the frozen table', () => {
  assert.equal(severityForImpact('critical'), 'blocker');
  assert.equal(severityForImpact('serious'), 'error');
  assert.equal(severityForImpact('moderate'), 'warning');
  assert.equal(severityForImpact('minor'), 'advisory');
});

test('severityForImpact falls back to the default for null/undefined impact', () => {
  assert.equal(severityForImpact(null), DEFAULT_VIOLATION_SEVERITY);
  assert.equal(severityForImpact(undefined), DEFAULT_VIOLATION_SEVERITY);
  // The documented default is a definite-but-non-blocking 'error'.
  assert.equal(DEFAULT_VIOLATION_SEVERITY, 'error');
});

test('semanticCategory: contrast rules → contrast', () => {
  assert.equal(semanticCategory('color-contrast'), 'contrast');
  assert.equal(semanticCategory('color-contrast-enhanced'), 'contrast');
});

test('semanticCategory: aria-* rules → aria', () => {
  assert.equal(semanticCategory('aria-required-children'), 'aria');
  assert.equal(semanticCategory('aria-valid-attr-value'), 'aria');
  assert.equal(semanticCategory('aria-hidden-focus'), 'aria');
});

test('semanticCategory: heading/landmark/list/table structure rules → structure', () => {
  assert.equal(semanticCategory('heading-order'), 'structure');
  assert.equal(semanticCategory('region'), 'structure');
  assert.equal(semanticCategory('landmark-one-main'), 'structure');
  assert.equal(semanticCategory('list'), 'structure');
  assert.equal(semanticCategory('listitem'), 'structure');
  assert.equal(semanticCategory('td-headers-attr'), 'structure');
  assert.equal(semanticCategory('th-has-data-cells'), 'structure');
});

test('semanticCategory: unclassified rules → undefined (caller defaults them)', () => {
  assert.equal(semanticCategory('image-alt'), undefined);
  assert.equal(semanticCategory('label'), undefined);
  assert.equal(semanticCategory('document-title'), undefined);
  assert.equal(semanticCategory('button-name'), undefined);
  assert.equal(semanticCategory('link-name'), undefined);
});

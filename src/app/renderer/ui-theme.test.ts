import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themedScreenRoot, uiThemeRootClass } from './ui-theme.js';

test('themedScreenRoot maps exactly the five redesign screens to their root class', () => {
  assert.equal(themedScreenRoot('inst-home'), 'inst');
  assert.equal(themedScreenRoot('inst-ask'), 'inst');
  assert.equal(themedScreenRoot('inst-brand'), 'inst');
  assert.equal(themedScreenRoot('inst-ingest'), 'inst');
  assert.equal(themedScreenRoot('remediate-review'), 'remed');
});

test('themedScreenRoot returns undefined for classic (non-redesign) screens', () => {
  for (const screen of [
    'home',
    'build-template',
    'build-details',
    'build-brand',
    'build-result',
    'remediate-source',
    'remediate-provide',
    'remediate-result',
    'guidance-ask',
    'guidance-answer',
    'alignment',
    'brand-manager',
    'saved-work',
    'not-a-real-screen',
  ]) {
    assert.equal(themedScreenRoot(screen), undefined, `expected ${screen} to have no dark variant`);
  }
});

test('uiThemeRootClass returns the existing classes unchanged in light mode', () => {
  assert.equal(uiThemeRootClass('inst', 'inst', 'light'), 'inst');
  assert.equal(uiThemeRootClass('remed', 'remed', 'light'), 'remed');
});

test('uiThemeRootClass appends the matching --dark modifier in dark mode', () => {
  assert.equal(uiThemeRootClass('inst', 'inst', 'dark'), 'inst inst--dark');
  assert.equal(uiThemeRootClass('remed', 'remed', 'dark'), 'remed remed--dark');
});

test('uiThemeRootClass preserves unrelated classes and never duplicates the modifier', () => {
  assert.equal(uiThemeRootClass('inst inst--wide', 'inst', 'dark'), 'inst inst--wide inst--dark');
  assert.equal(uiThemeRootClass('inst inst--wide inst--dark', 'inst', 'dark'), 'inst inst--wide inst--dark');
  assert.equal(uiThemeRootClass('inst inst--wide inst--dark', 'inst', 'light'), 'inst inst--wide');
});

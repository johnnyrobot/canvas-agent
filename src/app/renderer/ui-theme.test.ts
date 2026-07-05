import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appChromeClass, themedScreenRoot, uiThemeRootClass } from './ui-theme.js';

test('themedScreenRoot maps the inst/remed redesign screens to their root class', () => {
  assert.equal(themedScreenRoot('inst-home'), 'inst');
  assert.equal(themedScreenRoot('inst-ask'), 'inst');
  assert.equal(themedScreenRoot('inst-brand'), 'inst');
  assert.equal(themedScreenRoot('inst-ingest'), 'inst');
  assert.equal(themedScreenRoot('remediate-review'), 'remed');
});

test('themedScreenRoot maps the nine classic (Phase 2 reskin) screens to "classic"', () => {
  for (const screen of [
    'build-template',
    'build-details',
    'build-brand',
    'build-result',
    'remediate-source',
    'remediate-provide',
    'alignment',
    'brand-manager',
    'saved-work',
  ]) {
    assert.equal(themedScreenRoot(screen), 'classic', `expected ${screen} to map to classic`);
  }
});

test('themedScreenRoot returns undefined for unknown screen names', () => {
  assert.equal(themedScreenRoot('not-a-real-screen'), undefined);
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

test('uiThemeRootClass inserts the base root class when absent (classic screens render a plain "screen" root)', () => {
  assert.equal(uiThemeRootClass('screen', 'classic', 'light'), 'screen classic');
  assert.equal(uiThemeRootClass('screen', 'classic', 'dark'), 'screen classic classic--dark');
});

test('uiThemeRootClass base-class insertion is idempotent and preserves existing classes', () => {
  assert.equal(uiThemeRootClass('screen classic', 'classic', 'light'), 'screen classic');
  assert.equal(uiThemeRootClass('screen classic classic--dark', 'classic', 'dark'), 'screen classic classic--dark');
  assert.equal(uiThemeRootClass('screen classic classic--dark', 'classic', 'light'), 'screen classic');
});

test('appChromeClass adds "app--dark" to the #app root in dark mode, nothing in light mode', () => {
  assert.equal(appChromeClass('', 'light'), '');
  assert.equal(appChromeClass('', 'dark'), 'app--dark');
});

test('appChromeClass is idempotent and preserves unrelated classes', () => {
  assert.equal(appChromeClass('app--dark', 'dark'), 'app--dark');
  assert.equal(appChromeClass('some-other-class', 'dark'), 'some-other-class app--dark');
  assert.equal(appChromeClass('some-other-class app--dark', 'dark'), 'some-other-class app--dark');
});

test('appChromeClass removes "app--dark" when switching back to light', () => {
  assert.equal(appChromeClass('app--dark', 'light'), '');
  assert.equal(appChromeClass('some-other-class app--dark', 'light'), 'some-other-class');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContrast } from './contrast.js';
import { parseGradientStops } from './contrast.js';

// ── Anchor ratios (WCAG 2.x relative-luminance formula) ──────────────────────

test('black on white is the maximum 21.0', () => {
  const r = checkContrast('#000000', '#ffffff');
  assert.equal(r.ratio, 21);
  assert.equal(r.level, 'AAA');
  assert.equal(r.passesAA, true);
  assert.equal(r.passesAAA, true);
  assert.equal(r.size, 'normal');
});

test('identical colors are the minimum 1.0 and fail', () => {
  const r = checkContrast('#abcdef', '#abcdef');
  assert.equal(r.ratio, 1);
  assert.equal(r.level, 'fail');
  assert.equal(r.passesAA, false);
  assert.equal(r.passesAAA, false);
});

test('order of fg/bg does not change the ratio', () => {
  assert.equal(checkContrast('#000', '#fff').ratio, checkContrast('#fff', '#000').ratio);
});

// ── Known mid pair + the 3.0 / 4.5 boundary via size sensitivity ─────────────
// Pure red on white = exactly 4.0 (L_red = 0.2126): a clean boundary anchor.

test('red on white is 4.0 — fails AA-normal but passes AA-large', () => {
  const normal = checkContrast('#ff0000', '#ffffff');
  assert.equal(normal.ratio, 4);
  assert.equal(normal.level, 'fail'); // 4.0 < 4.5 normal threshold
  assert.equal(normal.passesAA, false);

  const large = checkContrast('#ff0000', '#ffffff', 'large');
  assert.equal(large.ratio, 4);
  assert.equal(large.level, 'AA'); // 4.0 ≥ 3.0 large-AA, < 4.5 large-AAA
  assert.equal(large.passesAA, true);
  assert.equal(large.passesAAA, false);
  assert.equal(large.size, 'large');
});

// A ratio between 4.5 and 7.0 flips AA→AAA when treated as large text.
// #008000 (CSS "green") on white ≈ 5.14.

test('a 4.5–7.0 pair is AA for normal text but AAA for large text', () => {
  const normal = checkContrast('#008000', '#ffffff');
  assert.ok(normal.ratio > 4.5 && normal.ratio < 7, `ratio ${normal.ratio}`);
  assert.equal(normal.level, 'AA');
  assert.equal(normal.passesAA, true);
  assert.equal(normal.passesAAA, false);

  const large = checkContrast('#008000', '#ffffff', 'large');
  assert.equal(large.level, 'AAA'); // ≥ 4.5 large-AAA
  assert.equal(large.passesAAA, true);
});

test('the classic #767676-on-white pair just passes AA-normal', () => {
  const r = checkContrast('#767676', '#ffffff');
  assert.ok(r.ratio >= 4.5, `expected ≥4.5, got ${r.ratio}`);
  assert.equal(r.passesAA, true);
  assert.equal(r.passesAAA, false);
  assert.equal(r.level, 'AA');
});

// ── Parsing: shorthand hex, alpha hex, rgb()/rgba(), %, named colors ─────────

test('3-digit and 4-digit hex expand correctly (alpha ignored)', () => {
  assert.equal(checkContrast('#000', '#fff').ratio, 21);
  assert.equal(checkContrast('#f00', '#fff').ratio, 4);
  // #rgba / #rrggbbaa: alpha is ignored for the ratio.
  assert.equal(checkContrast('#ff000080', '#ffffffff').ratio, 4);
  assert.equal(checkContrast('#f008', '#ffff').ratio, 4);
});

test('rgb() and rgba() parse with integers and percentages', () => {
  assert.equal(checkContrast('rgb(255,0,0)', 'rgb(255,255,255)').ratio, 4);
  assert.equal(checkContrast('rgba(255, 0, 0, 0.5)', 'white').ratio, 4);
  assert.equal(checkContrast('rgb(100%, 0%, 0%)', '#fff').ratio, 4);
});

test('named CSS colors are parsed case-insensitively', () => {
  assert.equal(checkContrast('red', 'white').ratio, 4);
  assert.equal(checkContrast('BLACK', 'White').ratio, 21);
  assert.equal(checkContrast('rebeccapurple', '#fff').ratio, checkContrast('#663399', '#fff').ratio);
});

// ── Invalid input throws ─────────────────────────────────────────────────────

test('invalid colors throw a clear Error', () => {
  assert.throws(() => checkContrast('notacolor', '#fff'), /color/i);
  assert.throws(() => checkContrast('#12', '#fff'), /color/i);
  assert.throws(() => checkContrast('#gggggg', '#fff'), /color/i);
  assert.throws(() => checkContrast('rgb(300)', '#fff'), /color/i);
  assert.throws(() => checkContrast('', '#fff'), /color/i);
});

test('transparent is rejected fail-safe (no defined contrast)', () => {
  assert.throws(() => checkContrast('transparent', '#fff'), /transparent|color/i);
});

test('a pair whose raw ratio is just below 4.5 fails AA even though it displays as 4.5', () => {
  // #767776 on white computes to ~4.496:1 (verified): displays as 4.5 after rounding,
  // but must FAIL the 4.5 threshold — the old round-before-compare wrongly passed it.
  const r = checkContrast('#767776', '#ffffff');
  assert.equal(r.ratio, 4.5);      // display value is rounded to 2dp
  assert.equal(r.passesAA, false); // raw 4.496 < 4.5 → fail
  assert.equal(r.level, 'fail');
});

test('parseGradientStops extracts colors and drops the direction token', () => {
  assert.deepEqual(
    parseGradientStops('linear-gradient(90deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)'),
    ['90deg', 'rgb(255, 0, 0)', 'rgb(0, 0, 255)'],
  );
});

test('parseGradientStops handles "to <side>", hex, named colors, and radial', () => {
  assert.deepEqual(parseGradientStops('linear-gradient(to right, #fff, #000)'), ['to', '#fff', '#000']);
  assert.deepEqual(parseGradientStops('radial-gradient(circle, red, blue 80%)'), ['circle', 'red', 'blue']);
});

test('parseGradientStops returns [] for non-gradients and conic gradients', () => {
  assert.deepEqual(parseGradientStops('url("x.png")'), []);
  assert.deepEqual(parseGradientStops('conic-gradient(red, blue)'), []);
});

import { parseColorAlpha, compositeLayers } from './contrast.js';

test('parseColorAlpha reads alpha from rgba, hex8, and treats transparent as a=0', () => {
  assert.deepEqual(parseColorAlpha('rgba(0, 0, 0, 0.5)'), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColorAlpha('#ff000080'), { r: 255, g: 0, b: 0, a: 128 / 255 });
  assert.deepEqual(parseColorAlpha('transparent'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(parseColorAlpha('#fff').a, 1);
});

test('compositeLayers folds a 50% black overlay onto white to mid-grey', () => {
  // top→bottom: a 50%-alpha black over the opaque white base → rgb(128,128,128) (rounded).
  assert.equal(compositeLayers(['rgba(0, 0, 0, 0.5)', 'rgb(255, 255, 255)']), 'rgb(128, 128, 128)');
});

test('compositeLayers returns the single opaque layer unchanged', () => {
  assert.equal(compositeLayers(['#ffffff']), 'rgb(255, 255, 255)');
  assert.equal(compositeLayers(['rgb(20, 40, 60)']), 'rgb(20, 40, 60)');
});

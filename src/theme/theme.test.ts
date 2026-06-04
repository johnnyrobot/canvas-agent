import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContrast } from '../engine/index.js';
import { WCAG } from '../contracts/index.js';
import { resolveTheme, accessibleForeground, DEFAULT_THEME_ROLES } from './theme.js';

// ── Test palettes ────────────────────────────────────────────────────────────
// High-contrast brand pair: dark navy + gold (mutual ratio ≫ 3:1).
const NAVY = '#0b3d91';
const GOLD = '#ffd700';
// Low-contrast brand pair: two pale pastels (mutual ratio ≈ 1.0).
const MISTYROSE = '#ffe4e1';
const LIGHTYELLOW = '#fafad2';

const isBlackOrWhite = (c: string) => c === '#000000' || c === '#ffffff';

// ── Default roles ────────────────────────────────────────────────────────────

test('default roles are used when `roles` is omitted', async () => {
  const result = await resolveTheme(NAVY, GOLD);
  assert.deepEqual(
    result.colors.map((c) => c.role),
    DEFAULT_THEME_ROLES,
  );
  // The exact default set the brief calls out.
  assert.deepEqual(DEFAULT_THEME_ROLES, ['heading', 'accent', 'button', 'callout', 'link']);
});

// ── Every returned pair MUST pass AA — the whole point of the resolver ────────

test('a high-contrast palette resolves with no warnings; every pair passes AA', async () => {
  const result = await resolveTheme(NAVY, GOLD);
  assert.equal(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join(' | ')}`);
  for (const c of result.colors) {
    assert.equal(c.contrast.passesAA, true, `${c.role} (${c.foreground} on ${c.background}) must pass AA`);
    assert.ok(isBlackOrWhite(c.foreground), `${c.role} foreground must be black or white`);
  }
});

test('a low-contrast pastel pair produces warnings, yet every returned pair still passes AA', async () => {
  const result = await resolveTheme(MISTYROSE, LIGHTYELLOW);
  assert.ok(result.warnings.length > 0, 'expected at least one warning for a low-contrast brand pair');
  // The resolver "fixed" the pairing by choosing accessible foregrounds.
  for (const c of result.colors) {
    assert.equal(c.contrast.passesAA, true, `${c.role} (${c.foreground} on ${c.background}) must pass AA`);
    assert.ok(isBlackOrWhite(c.foreground));
  }
});

// ── Role coverage ────────────────────────────────────────────────────────────

test('each requested role appears exactly once, in request order', async () => {
  const roles = ['heading', 'button', 'link'];
  const result = await resolveTheme(NAVY, GOLD, roles);
  const got = result.colors.map((c) => c.role);
  assert.deepEqual(got, roles);
  assert.equal(new Set(got).size, got.length, 'no role should be duplicated');
  assert.equal(result.colors.length, roles.length);
});

// ── contrast field is exactly checkContrast(foreground, background) ───────────

test('each contrast field matches an independent checkContrast(fg, bg) call', async () => {
  const result = await resolveTheme(NAVY, GOLD);
  for (const c of result.colors) {
    assert.deepEqual(c.contrast, checkContrast(c.foreground, c.background));
  }
});

// ── Background mapping is deterministic and drawn from the palette ────────────

test('backgrounds alternate color1 / color2 by role index', async () => {
  const roles = ['a', 'b', 'c', 'd'];
  const result = await resolveTheme(NAVY, GOLD, roles);
  assert.equal(result.colors[0]!.background, NAVY); // index 0 → color1
  assert.equal(result.colors[1]!.background, GOLD); // index 1 → color2
  assert.equal(result.colors[2]!.background, NAVY); // index 2 → color1
  assert.equal(result.colors[3]!.background, GOLD); // index 3 → color2
});

// ── accessibleForeground helper ──────────────────────────────────────────────

test('accessibleForeground picks white on a dark background, black on a light one', () => {
  const onDark = accessibleForeground('#000080');
  assert.equal(onDark.foreground, '#ffffff');
  assert.deepEqual(onDark.contrast, checkContrast('#ffffff', '#000080'));

  const onLight = accessibleForeground('#fffacd');
  assert.equal(onLight.foreground, '#000000');
  assert.deepEqual(onLight.contrast, checkContrast('#000000', '#fffacd'));
});

test('accessibleForeground always yields an AA-passing pair for any solid color', () => {
  // The better of black/white is provably ≥ ~4.58:1 against any opaque color.
  for (const bg of ['#777777', '#808080', '#7f7f7f', '#6a6a6a', '#999999', NAVY, GOLD, MISTYROSE]) {
    const { foreground, contrast } = accessibleForeground(bg);
    assert.ok(isBlackOrWhite(foreground));
    assert.equal(contrast.passesAA, true, `${foreground} on ${bg} should pass AA (ratio ${contrast.ratio})`);
    assert.ok(contrast.ratio >= WCAG.AA_NORMAL);
  }
});

// ── Input validation propagates from engine-core ─────────────────────────────

test('an invalid brand color rejects with a clear error', async () => {
  await assert.rejects(() => resolveTheme('notacolor', GOLD), /color/i);
  await assert.rejects(() => resolveTheme(NAVY, 'transparent'), /transparent|color/i);
});

// ── Purity / determinism ─────────────────────────────────────────────────────

test('resolveTheme is deterministic for identical inputs', async () => {
  const a = await resolveTheme(NAVY, GOLD);
  const b = await resolveTheme(NAVY, GOLD);
  assert.deepEqual(a, b);
});

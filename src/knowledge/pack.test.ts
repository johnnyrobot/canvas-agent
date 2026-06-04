import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPack, loadPacksDir } from './pack.js';

const PACKS_DIR = fileURLToPath(new URL('./packs', import.meta.url));

function validRaw() {
  return {
    id: 'demo',
    title: 'Demo Pack',
    intents: ['accessibility', 'audit'],
    units: [
      { id: 'u1', heading: 'Color contrast', text: 'Contrast must be 4.5:1.', citation: 'WCAG 2.2 §1.4.3' },
    ],
  };
}

test('loadPack accepts a plain object and normalizes it', () => {
  const pack = loadPack(validRaw());
  assert.equal(pack.id, 'demo');
  assert.equal(pack.title, 'Demo Pack');
  assert.deepEqual(pack.intents, ['accessibility', 'audit']);
  assert.equal(pack.units.length, 1);
  assert.equal(pack.units[0]?.id, 'u1');
  assert.equal(pack.units[0]?.citation, 'WCAG 2.2 §1.4.3');
});

test('loadPack trims whitespace on string fields', () => {
  const raw = validRaw();
  raw.id = '  demo  ';
  raw.units[0]!.text = '  Contrast must be 4.5:1.  ';
  const pack = loadPack(raw);
  assert.equal(pack.id, 'demo');
  assert.equal(pack.units[0]?.text, 'Contrast must be 4.5:1.');
});

test('loadPack defaults intents to [] and heading to "" when omitted', () => {
  const raw: Record<string, unknown> = {
    id: 'demo',
    title: 'Demo',
    units: [{ id: 'u1', text: 'Some text.', citation: 'Cite §1' }],
  };
  const pack = loadPack(raw);
  assert.deepEqual(pack.intents, []);
  assert.equal(pack.units[0]?.heading, '');
});

test('loadPack rejects non-object input', () => {
  assert.throws(() => loadPack(null), /pack/i);
  assert.throws(() => loadPack(42 as unknown), /pack/i);
  assert.throws(() => loadPack([] as unknown), /pack/i);
});

test('loadPack rejects a missing or empty id', () => {
  const raw = validRaw();
  // @ts-expect-error intentionally invalid
  delete raw.id;
  assert.throws(() => loadPack(raw), /id/i);
  assert.throws(() => loadPack({ ...validRaw(), id: '   ' }), /id/i);
});

test('loadPack rejects a pack with no units', () => {
  assert.throws(() => loadPack({ ...validRaw(), units: [] }), /unit/i);
  assert.throws(() => loadPack({ ...validRaw(), units: 'nope' }), /unit/i);
});

test('loadPack rejects a unit missing text or citation', () => {
  assert.throws(
    () => loadPack({ ...validRaw(), units: [{ id: 'u1', citation: 'c' }] }),
    /text/i,
  );
  assert.throws(
    () => loadPack({ ...validRaw(), units: [{ id: 'u1', text: 't' }] }),
    /citation/i,
  );
});

test('loadPack rejects duplicate unit ids within a pack', () => {
  const raw = {
    id: 'demo',
    title: 'Demo',
    units: [
      { id: 'dup', text: 'a', citation: 'c1' },
      { id: 'dup', text: 'b', citation: 'c2' },
    ],
  };
  assert.throws(() => loadPack(raw), /duplicate/i);
});

test('loadPack reads and parses a JSON file path', () => {
  const pack = loadPack(`${PACKS_DIR}/wcag-basics.json`);
  assert.equal(pack.id, 'wcag-basics');
  assert.ok(pack.units.length >= 1);
});

test('loadPacksDir loads every pack in the bundled packs directory', () => {
  const packs = loadPacksDir(PACKS_DIR);
  assert.ok(packs.length >= 2, 'expected at least two sample packs');
  const ids = packs.map((p) => p.id);
  assert.ok(ids.includes('wcag-basics'));
  assert.ok(ids.includes('canvas-templates'));
});

test('loadPacksDir returns packs in a deterministic (filename) order', () => {
  const a = loadPacksDir(PACKS_DIR).map((p) => p.id);
  const b = loadPacksDir(PACKS_DIR).map((p) => p.id);
  assert.deepEqual(a, b);
});

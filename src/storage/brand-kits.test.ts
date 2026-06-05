import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './database.js';
import { migrate } from './schema.js';
import { createBrandKitStore, type BrandKitStore } from './brand-kits.js';
import type { Database } from '../contracts/index.js';

async function harness(): Promise<{ db: Database; kits: BrandKitStore }> {
  const db = await openDatabase(':memory:');
  await migrate(db);
  return { db, kits: createBrandKitStore(db) };
}

test('saveBrandKit assigns id + createdAt and round-trips palette + fonts', async () => {
  const { db, kits } = await harness();
  const saved = await kits.saveBrandKit({
    name: 'Course Brand',
    palette: { primary: '#102040', secondary: '#f0c040' },
    fonts: { heading: 'Georgia', body: 'Arial', mono: 'Menlo' },
  });
  assert.equal(typeof saved.id, 'string');
  assert.ok(saved.id.length > 0);
  assert.equal(typeof saved.createdAt, 'string');
  assert.equal(saved.name, 'Course Brand');
  assert.deepEqual(saved.palette, { primary: '#102040', secondary: '#f0c040' });
  assert.deepEqual(saved.fonts, { heading: 'Georgia', body: 'Arial', mono: 'Menlo' });

  const list = await kits.listBrandKits();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], saved);
  await db.close();
});

test('fonts is omitted entirely when no fonts are provided', async () => {
  const { db, kits } = await harness();
  const saved = await kits.saveBrandKit({
    name: 'Minimal',
    palette: { primary: '#000000', secondary: '#ffffff' },
  });
  assert.ok(!('fonts' in saved), 'fonts should be omitted when no fonts provided');

  const [row] = await kits.listBrandKits();
  assert.ok(row);
  assert.ok(!('fonts' in row), 'fonts should stay omitted after a round-trip');
  await db.close();
});

test('partial fonts keep only the provided keys', async () => {
  const { db, kits } = await harness();
  const saved = await kits.saveBrandKit({
    name: 'Headings only',
    palette: { primary: '#111111', secondary: '#eeeeee' },
    fonts: { heading: 'Inter' },
  });
  assert.deepEqual(saved.fonts, { heading: 'Inter' });

  const [row] = await kits.listBrandKits();
  assert.deepEqual(row?.fonts, { heading: 'Inter' });
  await db.close();
});

test('listBrandKits returns newest first', async () => {
  const { db, kits } = await harness();
  const a = await kits.saveBrandKit({ name: 'A', palette: { primary: '#111', secondary: '#222' } });
  const b = await kits.saveBrandKit({ name: 'B', palette: { primary: '#333', secondary: '#444' } });
  // Pin distinct, known created_at values so ordering is deterministic.
  await db.run('UPDATE brand_kits SET created_at = ? WHERE id = ?', [
    '2026-01-01T00:00:00.000Z',
    a.id,
  ]);
  await db.run('UPDATE brand_kits SET created_at = ? WHERE id = ?', [
    '2026-02-01T00:00:00.000Z',
    b.id,
  ]);
  assert.deepEqual(
    (await kits.listBrandKits()).map((k) => k.id),
    [b.id, a.id],
  );
  await db.close();
});

test('deleteBrandKit removes only the targeted kit', async () => {
  const { db, kits } = await harness();
  const a = await kits.saveBrandKit({ name: 'A', palette: { primary: '#111', secondary: '#222' } });
  const b = await kits.saveBrandKit({ name: 'B', palette: { primary: '#333', secondary: '#444' } });
  await kits.deleteBrandKit(a.id);

  const remaining = await kits.listBrandKits();
  assert.deepEqual(
    remaining.map((k) => k.id),
    [b.id],
  );
  await db.close();
});

test('values are bound, not interpolated — an injection name is stored verbatim', async () => {
  const { db, kits } = await harness();
  const evil = "x'); DROP TABLE brand_kits; --";
  const saved = await kits.saveBrandKit({
    name: evil,
    palette: { primary: '#111', secondary: '#222' },
  });
  assert.equal(saved.name, evil);
  // If the payload had executed, the table would be gone and this would throw.
  const [row] = await kits.listBrandKits();
  assert.equal(row?.name, evil);
  await db.close();
});

test('re-running migrate() keeps brand_kits usable (idempotent)', async () => {
  const db = await openDatabase(':memory:');
  await migrate(db);
  await migrate(db);
  const kits = createBrandKitStore(db);
  const saved = await kits.saveBrandKit({
    name: 'K',
    palette: { primary: '#111', secondary: '#222' },
  });
  assert.equal((await kits.listBrandKits())[0]?.id, saved.id);
  await db.close();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './database.js';
import type { Database } from '../contracts/index.js';

async function freshDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT, n INTEGER)');
  return db;
}

test('round-trips an insert and select using bound parameters', async () => {
  const db = await freshDb();
  await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['a', 'hello', 7]);
  const row = await db.get<{ id: string; label: string; n: number }>(
    'SELECT id, label, n FROM items WHERE id = ?',
    ['a'],
  );
  assert.deepEqual(row, { id: 'a', label: 'hello', n: 7 });
  await db.close();
});

test('all() returns every matching row', async () => {
  const db = await freshDb();
  await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['a', 'x', 1]);
  await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['b', 'y', 2]);
  const rows = await db.all<{ id: string }>('SELECT id FROM items ORDER BY id');
  assert.deepEqual(rows, [{ id: 'a' }, { id: 'b' }]);
  await db.close();
});

test('run() reports the number of changed rows as a number', async () => {
  const db = await freshDb();
  await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['a', 'x', 1]);
  await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['b', 'y', 2]);
  const res = await db.run('UPDATE items SET label = ? WHERE n > ?', ['z', 0]);
  assert.equal(typeof res.changes, 'number');
  assert.equal(res.changes, 2);
  await db.close();
});

test('get() returns undefined when no row matches', async () => {
  const db = await freshDb();
  const row = await db.get('SELECT id FROM items WHERE id = ?', ['missing']);
  assert.equal(row, undefined);
  await db.close();
});

test('parameter values are bound literally — no SQL injection', async () => {
  const db = await freshDb();
  const evil = "'); DROP TABLE items; --";
  await db.run('INSERT INTO items (id, label, n) VALUES (?, ?, ?)', ['a', evil, 0]);
  // If the payload had executed, the table would be gone and this would throw.
  const row = await db.get<{ label: string }>('SELECT label FROM items WHERE id = ?', ['a']);
  assert.equal(row?.label, evil);
  await db.close();
});

test('opening enables foreign-key enforcement', async () => {
  const db = await openDatabase(':memory:');
  const row = await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys');
  assert.equal(row?.foreign_keys, 1);
  await db.close();
});

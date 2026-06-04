import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './database.js';
import { migrate, SCHEMA_VERSION } from './schema.js';
import type { Database } from '../contracts/index.js';

async function migratedDb(): Promise<Database> {
  const db = await openDatabase(':memory:');
  await migrate(db);
  return db;
}

async function tableExists(db: Database, name: string): Promise<boolean> {
  const row = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
    name,
  ]);
  return row !== undefined;
}

test('creates the core application tables', async () => {
  const db = await migratedDb();
  for (const table of ['projects', 'sessions', 'turns', 'canvas_imports', 'meta']) {
    assert.ok(await tableExists(db, table), `expected table "${table}" to exist`);
  }
  await db.close();
});

test('does NOT create knowledge-track tables (kb_* / FTS5 are owned elsewhere)', async () => {
  const db = await migratedDb();
  const rows = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kb_%'",
  );
  assert.deepEqual(rows, []);
  await db.close();
});

test('migrate is idempotent — running it twice does not throw', async () => {
  const db = await openDatabase(':memory:');
  await migrate(db);
  await migrate(db);
  assert.ok(await tableExists(db, 'projects'));
  await db.close();
});

test('records the schema version in meta', async () => {
  const db = await migratedDb();
  const row = await db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    'schema_version',
  ]);
  assert.equal(row?.value, String(SCHEMA_VERSION));
  await db.close();
});

test('foreign keys are enforced — a session needs an existing project', async () => {
  const db = await migratedDb();
  assert.throws(() => {
    db.run('INSERT INTO sessions (id, project_id, created_at) VALUES (?, ?, ?)', [
      's1',
      'nonexistent-project',
      '2026-06-04T00:00:00Z',
    ]);
  }, /FOREIGN KEY/i);
  await db.close();
});

test('a turn cascade-deletes with its session', async () => {
  const db = await migratedDb();
  await db.run('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', ['p1', 'P', 't']);
  await db.run('INSERT INTO sessions (id, project_id, created_at) VALUES (?, ?, ?)', [
    's1',
    'p1',
    't',
  ]);
  await db.run(
    'INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ['t1', 's1', 'user', 'hi', 't'],
  );
  await db.run('DELETE FROM sessions WHERE id = ?', ['s1']);
  const turns = await db.all('SELECT id FROM turns');
  assert.deepEqual(turns, []);
  await db.close();
});

test('canvas_imports is keyed by course_id and round-trips a summary', async () => {
  const db = await migratedDb();
  await db.run(
    'INSERT INTO canvas_imports (course_id, name, imported_at, summary_json) VALUES (?, ?, ?, ?)',
    ['c1', 'Bio 101', '2026-06-04T00:00:00Z', '{"pages":3}'],
  );
  const row = await db.get<{ name: string; summary_json: string }>(
    'SELECT name, summary_json FROM canvas_imports WHERE course_id = ?',
    ['c1'],
  );
  assert.equal(row?.name, 'Bio 101');
  assert.equal(row?.summary_json, '{"pages":3}');
  await db.close();
});

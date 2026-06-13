import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from './database.js';
import { migrate } from './schema.js';
import { createSessionStore, type SessionStore } from './sessions.js';
import type { Database, TurnFragment } from '../contracts/index.js';

async function harness(): Promise<{ db: Database; sessions: SessionStore }> {
  const db = await openDatabase(':memory:');
  await migrate(db);
  return { db, sessions: createSessionStore(db) };
}

test('create → append → load round-trips a session and its transcript', async () => {
  const { db, sessions } = await harness();
  const created = await sessions.createSession({ title: 'My Syllabus', mode: 'build' });
  assert.equal(typeof created.id, 'string');
  assert.ok(created.id.length > 0);
  assert.equal(created.title, 'My Syllabus');
  assert.equal(created.mode, 'build');
  assert.equal(created.createdAt, created.updatedAt);

  await sessions.appendMessages(created.id, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ]);

  const state = await sessions.loadSession(created.id);
  assert.ok(state);
  assert.equal(state.session.id, created.id);
  assert.equal(state.session.title, 'My Syllabus');
  assert.equal(state.session.mode, 'build');
  assert.deepEqual(state.messages, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ]);
  await db.close();
});

test('append → load round-trips a message’s gated fragments (C10)', async () => {
  const { db, sessions } = await harness();
  const created = await sessions.createSession({ title: 'Build', mode: 'build' });
  const fragment: TurnFragment = {
    html: '<h2>Module 1</h2>',
    gate: {
      html: '<h2>Module 1</h2>',
      badgeWithheld: false,
      conformance: { passedChecks: true, blockers: [], warnings: [], needsHumanReview: [] },
    },
  };
  await sessions.appendMessages(created.id, [
    { role: 'user', content: 'build module 1' },
    { role: 'assistant', content: 'Here it is.', fragments: [fragment] },
  ]);

  const state = await sessions.loadSession(created.id);
  assert.ok(state);
  assert.equal(state.messages.length, 2);
  // The gated HTML + conformance (the actual work product) survive a reload.
  assert.deepEqual(state.messages[1]?.fragments, [fragment]);
  // A message without fragments keeps the lean LLM-history shape (no fragments key).
  assert.equal('fragments' in state.messages[0]!, false);
  await db.close();
});

test('loadSession returns null for an unknown id', async () => {
  const { db, sessions } = await harness();
  assert.equal(await sessions.loadSession('does-not-exist'), null);
  await db.close();
});

test('messages load in append order across multiple appends', async () => {
  const { db, sessions } = await harness();
  const s = await sessions.createSession({ title: 'S', mode: 'guidance' });
  await sessions.appendMessages(s.id, [
    { role: 'user', content: '1' },
    { role: 'assistant', content: '2' },
  ]);
  await sessions.appendMessages(s.id, [
    { role: 'user', content: '3' },
    { role: 'assistant', content: '4' },
  ]);
  const state = await sessions.loadSession(s.id);
  assert.deepEqual(
    state?.messages.map((m) => m.content),
    ['1', '2', '3', '4'],
  );
  await db.close();
});

test('listSessions returns newest-updated first', async () => {
  const { db, sessions } = await harness();
  const a = await sessions.createSession({ title: 'A', mode: 'guidance' });
  const b = await sessions.createSession({ title: 'B', mode: 'guidance' });
  // Pin distinct, known updated_at values so ordering is deterministic.
  await db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [
    '2026-01-01T00:00:00.000Z',
    a.id,
  ]);
  await db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [
    '2026-02-01T00:00:00.000Z',
    b.id,
  ]);
  assert.deepEqual(
    (await sessions.listSessions()).map((s) => s.id),
    [b.id, a.id],
  );

  // Touching A makes it the most recently updated → it moves to the front.
  await db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [
    '2026-03-01T00:00:00.000Z',
    a.id,
  ]);
  assert.deepEqual(
    (await sessions.listSessions()).map((s) => s.id),
    [a.id, b.id],
  );
  await db.close();
});

test('appendMessages bumps updated_at', async () => {
  const { db, sessions } = await harness();
  const s = await sessions.createSession({ title: 'S', mode: 'guidance' });
  // Pin updated_at far in the past, then append and confirm it advanced to now.
  await db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [
    '2000-01-01T00:00:00.000Z',
    s.id,
  ]);
  await sessions.appendMessages(s.id, [{ role: 'user', content: 'hi' }]);
  const row = await db.get<{ updated_at: string }>(
    'SELECT updated_at FROM sessions WHERE id = ?',
    [s.id],
  );
  assert.ok(row);
  assert.ok(
    row.updated_at > '2000-01-01T00:00:00.000Z',
    'updated_at should advance past the pinned value',
  );
  await db.close();
});

test('deleteSession cascades to its turns', async () => {
  const { db, sessions } = await harness();
  const s = await sessions.createSession({ title: 'S', mode: 'build' });
  await sessions.appendMessages(s.id, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
  ]);
  await sessions.deleteSession(s.id);

  assert.equal(await sessions.loadSession(s.id), null);
  const turns = await db.all('SELECT id FROM turns WHERE session_id = ?', [s.id]);
  assert.deepEqual(turns, []);
  await db.close();
});

test('values are bound, not interpolated — an injection title is stored verbatim', async () => {
  const { db, sessions } = await harness();
  const evil = "Robert'); DROP TABLE sessions; --";
  const created = await sessions.createSession({ title: evil, mode: 'guidance' });
  const state = await sessions.loadSession(created.id);
  assert.ok(state);
  assert.equal(state.session.title, evil);
  // If the payload had executed, the table would be gone and this would throw.
  assert.equal((await sessions.listSessions()).length, 1);
  await db.close();
});

test('re-running migrate() is idempotent for the sessions store', async () => {
  const db = await openDatabase(':memory:');
  await migrate(db);
  await migrate(db);
  const sessions = createSessionStore(db);
  const s = await sessions.createSession({ title: 'S', mode: 'build' });
  assert.equal((await sessions.loadSession(s.id))?.session.title, 'S');
  await db.close();
});

test('migrate upgrades a pre-existing v1 sessions table in place (guarded ALTERs)', async () => {
  const db = await openDatabase(':memory:');
  // Simulate a v1 DB: a `sessions` table WITHOUT title / mode / updated_at.
  await db.exec(
    `CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
  );
  await db.exec(
    `CREATE TABLE sessions (
       id         TEXT PRIMARY KEY,
       project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
       created_at TEXT NOT NULL
     )`,
  );
  await db.run('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', [
    'default',
    'Default',
    '2026-01-01T00:00:00.000Z',
  ]);
  await db.run('INSERT INTO sessions (id, project_id, created_at) VALUES (?, ?, ?)', [
    'old',
    'default',
    '2026-01-01T00:00:00.000Z',
  ]);

  // migrate must add the new columns without dropping the existing row.
  await migrate(db);

  const sessions = createSessionStore(db);
  const list = await sessions.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, 'old');

  // The upgraded session is fully usable through the store.
  await sessions.appendMessages('old', [{ role: 'user', content: 'still here' }]);
  const state = await sessions.loadSession('old');
  assert.equal(state?.messages.length, 1);
  assert.equal(state?.messages[0]?.content, 'still here');
  await db.close();
});

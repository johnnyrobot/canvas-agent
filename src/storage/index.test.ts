import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as storage from './index.js';

test('the public surface exports the five contract functions', () => {
  assert.equal(typeof storage.openDatabase, 'function');
  assert.equal(typeof storage.createKeychainSecretStore, 'function');
  assert.equal(typeof storage.createInMemorySecretStore, 'function');
  assert.equal(typeof storage.resolveAppPaths, 'function');
  assert.equal(typeof storage.migrate, 'function');
});

test('end-to-end: open → migrate → insert/read a project', async () => {
  const db = await storage.openDatabase(':memory:');
  await storage.migrate(db);
  await db.run('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)', [
    'p1',
    'My Course',
    't0',
  ]);
  const row = await db.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', ['p1']);
  assert.equal(row?.name, 'My Course');
  await db.close();
});

test('end-to-end: resolveAppPaths + in-memory secret store wire together', async () => {
  const paths = storage.resolveAppPaths({ dataDir: '/tmp/canvas-agent-e2e' });
  assert.equal(paths.dbPath, '/tmp/canvas-agent-e2e/canvas-agent.sqlite');
  const secrets = storage.createInMemorySecretStore();
  await secrets.set('canvas-token', 'tok');
  assert.equal(await secrets.get('canvas-token'), 'tok');
});

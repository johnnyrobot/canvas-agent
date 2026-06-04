import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveAppPaths } from './paths.js';

test('default layout sits under ~/Library/Application Support/CanvasAgent', () => {
  const p = resolveAppPaths();
  const dataDir = join(homedir(), 'Library', 'Application Support', 'CanvasAgent');
  assert.equal(p.dataDir, dataDir);
  assert.equal(p.dbPath, join(dataDir, 'canvas-agent.sqlite'));
  assert.equal(p.uploadsDir, join(dataDir, 'uploads'));
  assert.equal(p.exportsDir, join(dataDir, 'exports'));
});

test('every resolved path is absolute', () => {
  const p = resolveAppPaths();
  assert.ok(isAbsolute(p.dataDir));
  assert.ok(isAbsolute(p.dbPath));
  assert.ok(isAbsolute(p.uploadsDir));
  assert.ok(isAbsolute(p.exportsDir));
});

test('overriding dataDir re-bases the derived paths under it', () => {
  const tmp = '/tmp/canvas-agent-test';
  const p = resolveAppPaths({ dataDir: tmp });
  assert.equal(p.dataDir, tmp);
  assert.equal(p.dbPath, join(tmp, 'canvas-agent.sqlite'));
  assert.equal(p.uploadsDir, join(tmp, 'uploads'));
  assert.equal(p.exportsDir, join(tmp, 'exports'));
});

test('an explicit field override wins over the derived default', () => {
  const tmp = '/tmp/canvas-agent-test';
  const p = resolveAppPaths({ dataDir: tmp, dbPath: '/tmp/elsewhere/db.sqlite' });
  assert.equal(p.dbPath, '/tmp/elsewhere/db.sqlite');
  // The non-overridden fields still follow dataDir.
  assert.equal(p.uploadsDir, join(tmp, 'uploads'));
});

test('a relative override is resolved to an absolute path', () => {
  const p = resolveAppPaths({ dataDir: 'relative/dir' });
  assert.ok(isAbsolute(p.dataDir));
  assert.ok(isAbsolute(p.dbPath));
});

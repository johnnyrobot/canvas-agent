import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveAppPaths } from './paths.js';

test('default layout sits under ~/Library/Application Support/CanvasAgent', () => {
  // Explicitly env-free: CANVAS_AGENT_DATA_DIR would otherwise re-base all of this.
  withDataDirEnv(undefined, () => {
    const p = resolveAppPaths();
    const dataDir = join(homedir(), 'Library', 'Application Support', 'CanvasAgent');
    assert.equal(p.dataDir, dataDir);
    assert.equal(p.dbPath, join(dataDir, 'canvas-agent.sqlite'));
    assert.equal(p.uploadsDir, join(dataDir, 'uploads'));
    assert.equal(p.exportsDir, join(dataDir, 'exports'));
    assert.equal(p.modelsDir, join(dataDir, 'docling-models'));
    assert.equal(p.catalogHomeDir, join(dataDir, 'catalog-home'));
  });
});

test('every resolved path is absolute', () => {
  const p = resolveAppPaths();
  assert.ok(isAbsolute(p.dataDir));
  assert.ok(isAbsolute(p.dbPath));
  assert.ok(isAbsolute(p.uploadsDir));
  assert.ok(isAbsolute(p.exportsDir));
  assert.ok(isAbsolute(p.modelsDir));
  assert.ok(isAbsolute(p.catalogHomeDir));
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

/** Run `fn` with CANVAS_AGENT_DATA_DIR set to `value` (or unset), then restore. */
function withDataDirEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.CANVAS_AGENT_DATA_DIR;
  if (value === undefined) delete process.env.CANVAS_AGENT_DATA_DIR;
  else process.env.CANVAS_AGENT_DATA_DIR = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CANVAS_AGENT_DATA_DIR;
    else process.env.CANVAS_AGENT_DATA_DIR = prev;
  }
}

test('CANVAS_AGENT_DATA_DIR re-bases the whole layout', () => {
  withDataDirEnv('/tmp/canvas-agent-env', () => {
    const p = resolveAppPaths();
    assert.equal(p.dataDir, '/tmp/canvas-agent-env');
    assert.equal(p.dbPath, join('/tmp/canvas-agent-env', 'canvas-agent.sqlite'));
    assert.equal(p.catalogHomeDir, join('/tmp/canvas-agent-env', 'catalog-home'));
  });
});

test('an explicit dataDir argument beats CANVAS_AGENT_DATA_DIR', () => {
  withDataDirEnv('/tmp/canvas-agent-env', () => {
    const p = resolveAppPaths({ dataDir: '/tmp/canvas-agent-explicit' });
    assert.equal(p.dataDir, '/tmp/canvas-agent-explicit');
    assert.equal(p.catalogHomeDir, join('/tmp/canvas-agent-explicit', 'catalog-home'));
  });
});

test('a relative CANVAS_AGENT_DATA_DIR is resolved to an absolute path', () => {
  withDataDirEnv('relative/env/dir', () => {
    assert.ok(isAbsolute(resolveAppPaths().dataDir));
  });
});

test('an empty CANVAS_AGENT_DATA_DIR is ignored, not treated as cwd', () => {
  withDataDirEnv('', () => {
    const dataDir = join(homedir(), 'Library', 'Application Support', 'CanvasAgent');
    assert.equal(resolveAppPaths().dataDir, dataDir);
  });
});

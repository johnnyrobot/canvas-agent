import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ensureCatalogHome } from './catalog-home.js';

test('copies the seed to <home>/data/data.db when absent', () => {
  const copied: Array<[string, string]> = [];
  const made: string[] = [];
  const present = new Set<string>(); // nothing exists yet
  const home = ensureCatalogHome({
    seedDbPath: '/bundle/seed/data.db',
    homeDir: '/u/catalog-home',
    exists: (p) => present.has(p),
    mkdir: (p) => made.push(p),
    copyFile: (s, d) => copied.push([s, d]),
  });
  assert.equal(home, '/u/catalog-home');
  assert.deepEqual(copied, [['/bundle/seed/data.db', path.join('/u/catalog-home', 'data', 'data.db')]]);
  assert.ok(made.includes(path.join('/u/catalog-home', 'data')));
});

test('does not re-copy when the home DB already exists', () => {
  const copied: Array<[string, string]> = [];
  const dbPath = path.join('/u/catalog-home', 'data', 'data.db');
  ensureCatalogHome({
    seedDbPath: '/bundle/seed/data.db',
    homeDir: '/u/catalog-home',
    exists: (p) => p === dbPath, // DB already present
    mkdir: () => {},
    copyFile: (s, d) => copied.push([s, d]),
  });
  assert.equal(copied.length, 0);
});

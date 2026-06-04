import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRetriever,
  loadPack,
  loadPacksDir,
  RUBRIC_ID_PATTERN,
} from './index.js';

test('index re-exports the public surface', () => {
  assert.equal(typeof createRetriever, 'function');
  assert.equal(typeof loadPack, 'function');
  assert.equal(typeof loadPacksDir, 'function');
  assert.ok(RUBRIC_ID_PATTERN instanceof RegExp);
});

test('createRetriever from index returns a working KbRetriever', async () => {
  const retrieve = createRetriever();
  const result = await retrieve('color contrast');
  assert.ok(Array.isArray(result.hits));
  assert.ok(result.hits.length > 0);
  const hit = result.hits[0]!;
  for (const key of ['id', 'packId', 'title', 'snippet', 'score', 'citation'] as const) {
    assert.ok(key in hit, `hit missing ${key}`);
  }
});

test('the bundled rubric pack routes a real rubric id', async () => {
  const retrieve = createRetriever();
  const { hits } = await retrieve('RUB-2');
  assert.ok(hits.some((h) => h.packId === 'rubric-criteria' && h.id.includes('RUB-2')));
});

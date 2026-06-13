import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppApi } from '../contracts/index.js';
import { buildApi } from './build-api.js';
import { createUnavailableApi } from './unavailable-api.js';

test('createUnavailableApi reports the runtime as DOWN, never healthy (C3)', async () => {
  const api = createUnavailableApi('boom');
  assert.deepEqual(await api.health(), { llm: false, ingest: false });
});

test('createUnavailableApi never fabricates a turn result — runTurn rejects (C3)', async () => {
  const api = createUnavailableApi('sidecars missing');
  await assert.rejects(() => api.runTurn({ user: 'make me a page' }), /unavailable|sidecars missing/i);
});

test('createUnavailableApi refuses runtime actions rather than faking success (C3)', async () => {
  const api = createUnavailableApi('down');
  await assert.rejects(() => api.saveCanvasAuth({ baseUrl: 'https://x', token: 't' }));
  await assert.rejects(() => api.importCanvas('https://x', '1'));
  await assert.rejects(() => api.fetchCanvasPage('https://x', '1', 'p'));
  await assert.rejects(() => api.resolveBrandTheme('#111111', '#222222'));
});

test('buildApi falls back to the honest unavailable API when the runtime throws (C3)', async () => {
  const api = buildApi(() => {
    throw new Error('no sidecars');
  });
  assert.deepEqual(await api.health(), { llm: false, ingest: false });
  await assert.rejects(() => api.runTurn({ user: 'x' }));
});

test('buildApi returns the real runtime when construction succeeds', async () => {
  const real = {
    async health() {
      return { llm: true, ingest: true };
    },
  } as unknown as AppApi;
  assert.equal(buildApi(() => real), real);
});

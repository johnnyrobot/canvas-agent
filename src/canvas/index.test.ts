import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCourse, createImporter, createCanvasGet, parseLinkNext } from './index.js';
import type { CanvasImporter } from '../contracts/index.js';
import { fakeCanvas } from './fake-canvas.js';

test('index exposes the public surface', () => {
  assert.equal(typeof importCourse, 'function');
  assert.equal(typeof createImporter, 'function');
  assert.equal(typeof createCanvasGet, 'function');
  assert.equal(typeof parseLinkNext, 'function');
});

test('importCourse conforms to the frozen CanvasImporter port', () => {
  // Compile-time conformance: this assignment fails typecheck if the signature drifts.
  const port: CanvasImporter = importCourse;
  assert.equal(typeof port, 'function');
});

test('createImporter wires an injected fetch end-to-end', async () => {
  const { fetch } = fakeCanvas((url) =>
    url.pathname.endsWith('/courses/1') ? { body: { name: 'Smoke' } } : { body: [] },
  );

  const result = await createImporter({ fetch, now: () => '2026-01-01T00:00:00.000Z' })(
    { baseUrl: 'https://x.instructure.com', token: 't' },
    '1',
  );

  assert.equal(result.name, 'Smoke');
  assert.equal(result.pages, 0);
  assert.equal(result.assignments, 0);
  assert.equal(result.files, 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppApi } from '../contracts/index.js';
import { createStubApi } from './stub-api.js';

test('createStubApi returns an object with the three AppApi methods', () => {
  const api: AppApi = createStubApi();
  assert.equal(typeof api.runTurn, 'function');
  assert.equal(typeof api.importCanvas, 'function');
  assert.equal(typeof api.health, 'function');
});

test('runTurn returns a sane TurnView referencing the prompt', async () => {
  const api = createStubApi();
  const view = await api.runTurn({ user: 'design a welcome page' });

  assert.ok(view.text.length > 0, 'expected non-empty assistant text');
  assert.ok(view.text.includes('design a welcome page'), 'text should reference the prompt');
  assert.ok(Array.isArray(view.toolsUsed) && view.toolsUsed.length > 0);
  assert.ok(view.iterations >= 1);
});

test('runTurn emits one passing fragment and one badge-withheld fragment', async () => {
  const api = createStubApi();
  const view = await api.runTurn({ user: 'hi' });

  assert.ok(view.fragments.length >= 2, 'need at least a passing and a withheld fragment');

  const passing = view.fragments.find((f) => !f.gate.badgeWithheld);
  const withheld = view.fragments.find((f) => f.gate.badgeWithheld);
  assert.ok(passing, 'expected a passing fragment');
  assert.ok(withheld, 'expected a badge-withheld fragment');

  // Passing fragment is internally consistent.
  assert.equal(passing.gate.conformance.passedChecks, true);
  assert.equal(passing.gate.conformance.blockers.length, 0);
  assert.ok(passing.gate.html.length > 0);

  // Withheld fragment has at least one blocker and withholds the badge.
  assert.equal(withheld.gate.conformance.passedChecks, false);
  assert.ok(withheld.gate.conformance.blockers.length >= 1);
});

test('each fragment.html matches its gate.html (the gated, safe-to-render HTML)', async () => {
  const api = createStubApi();
  const view = await api.runTurn({ user: 'hi' });
  for (const f of view.fragments) {
    assert.equal(f.html, f.gate.html);
  }
});

test('importCanvas echoes the courseId and returns numeric counts', async () => {
  const api = createStubApi();
  const result = await api.importCanvas({ baseUrl: 'https://x.instructure.com', token: 't' }, '4567');

  assert.equal(result.courseId, '4567');
  assert.ok(result.name.length > 0);
  assert.ok(!Number.isNaN(Date.parse(result.importedAt)), 'importedAt should be an ISO date');
  assert.equal(typeof result.pages, 'number');
  assert.equal(typeof result.assignments, 'number');
  assert.equal(typeof result.files, 'number');
  assert.ok(Array.isArray(result.warnings));
});

test('health reports both sidecars up', async () => {
  const api = createStubApi();
  assert.deepEqual(await api.health(), { llm: true, ingest: true });
});

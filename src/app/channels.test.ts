import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  CHUNK,
  RUN_TURN,
  IMPORT_CANVAS,
  HEALTH,
  INGEST_PULL_PROGRESS,
} from './channels.js';

test('exposes the original three IPC channel names', () => {
  assert.equal(RUN_TURN, 'canvasAgent:runTurn');
  assert.equal(IMPORT_CANVAS, 'canvasAgent:importCanvas');
  assert.equal(HEALTH, 'canvasAgent:health');
});

// NOTE: the former 'CHANNELS bundles every request/response channel' test was
// deleted per ADR-0001. It compared `CHANNELS` to its own constituent constants,
// which proved nothing the file didn't already say. The real invariant — one
// channel per `AppApi` method, and nothing else — is now the
// `satisfies Record<keyof AppApi, string>` constraint on `CHANNELS` itself.

test('channel names are all distinct', () => {
  const values = Object.values(CHANNELS);
  assert.equal(new Set(values).size, values.length, 'channel names must be unique');
});

test('every channel name (incl. the CHUNK event) is namespaced under "canvasAgent:"', () => {
  for (const name of [...Object.values(CHANNELS), CHUNK]) {
    assert.match(name, /^canvasAgent:/);
  }
});

test('CHUNK is a separate one-way event channel, NOT part of CHANNELS', () => {
  assert.equal(CHUNK, 'canvasAgent:chunk');
  assert.ok(
    !Object.values(CHANNELS).includes(CHUNK as (typeof CHANNELS)[keyof typeof CHANNELS]),
    'CHUNK must not be a request/response handler channel',
  );
});

test('INGEST_PULL_PROGRESS is a separate one-way event channel, NOT part of CHANNELS', () => {
  assert.equal(INGEST_PULL_PROGRESS, 'canvasAgent:ingestPullProgress');
  assert.ok(
    !Object.values(CHANNELS).includes(INGEST_PULL_PROGRESS as (typeof CHANNELS)[keyof typeof CHANNELS]),
    'INGEST_PULL_PROGRESS must not be a request/response handler channel',
  );
});

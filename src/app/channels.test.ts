import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNELS, RUN_TURN, IMPORT_CANVAS, HEALTH } from './channels.js';

test('exposes the three IPC channel names', () => {
  assert.equal(RUN_TURN, 'canvasAgent:runTurn');
  assert.equal(IMPORT_CANVAS, 'canvasAgent:importCanvas');
  assert.equal(HEALTH, 'canvasAgent:health');
});

test('CHANNELS bundles every channel and they are all distinct', () => {
  const values = Object.values(CHANNELS);
  assert.deepEqual(values, [RUN_TURN, IMPORT_CANVAS, HEALTH]);
  assert.equal(new Set(values).size, values.length, 'channel names must be unique');
});

test('every channel name is namespaced under "canvasAgent:"', () => {
  for (const name of Object.values(CHANNELS)) {
    assert.match(name, /^canvasAgent:/);
  }
});

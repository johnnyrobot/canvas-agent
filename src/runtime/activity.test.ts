import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityTracker, noopActivityTracker } from './activity.js';

test('whenIdle resolves immediately when nothing is in flight', async () => {
  const tracker = createActivityTracker();
  assert.equal(await tracker.whenIdle(1_000), true);
});

test('whenIdle waits for an in-flight turn, then resolves true when it ends', async () => {
  const tracker = createActivityTracker();
  const endTurn = tracker.begin();
  let settled = false;
  const idle = tracker.whenIdle(1_000).then((v) => {
    settled = true;
    return v;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'must not resolve while a turn is in flight');
  endTurn();
  assert.equal(await idle, true);
});

test('whenIdle resolves false when the drain deadline expires first', async () => {
  const tracker = createActivityTracker();
  tracker.begin(); // deliberately never released
  assert.equal(await tracker.whenIdle(10), false);
});

test('releasing the same turn twice cannot drive the count negative', async () => {
  const tracker = createActivityTracker();
  const endA = tracker.begin();
  const endB = tracker.begin();
  endA();
  endA();
  endA();
  assert.equal(await tracker.whenIdle(10), false, 'turn B is still in flight');
  endB();
  assert.equal(await tracker.whenIdle(10), true);
});

test('idle requires every concurrent turn to end', async () => {
  const tracker = createActivityTracker();
  const ends = [tracker.begin(), tracker.begin(), tracker.begin()];
  ends[0]!();
  ends[1]!();
  assert.equal(await tracker.whenIdle(10), false);
  ends[2]!();
  assert.equal(await tracker.whenIdle(10), true);
});

test('a turn that throws still releases its bracket', async () => {
  const tracker = createActivityTracker();
  const endTurn = tracker.begin();
  try {
    throw new Error('turn blew up');
  } catch {
    endTurn();
  }
  assert.equal(await tracker.whenIdle(10), true);
});

test('the no-op tracker is always idle', async () => {
  assert.equal(await noopActivityTracker.whenIdle(0), true);
  noopActivityTracker.begin()();
  assert.equal(await noopActivityTracker.whenIdle(0), true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mutex } from './mutex.js';

/** Flush all pending microtasks + timers so ordering assertions are deterministic. */
const flush = () => new Promise((r) => setTimeout(r, 0));

test('run() serializes: the second body starts only after the first resolves', async () => {
  const mutex = new Mutex();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstBody = new Promise<void>((r) => (releaseFirst = r));

  const a = mutex.run(async () => {
    events.push('a:start');
    await firstBody;
    events.push('a:end');
  });
  const b = mutex.run(async () => {
    events.push('b:start');
  });

  await flush();
  // While `a` holds the lock (its body is awaiting), `b` must not have begun.
  assert.deepEqual(events, ['a:start'], 'b must wait for a to release the lock');

  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(events, ['a:start', 'a:end', 'b:start'], 'FIFO order, no overlap');
});

test('a throwing body still releases the lock (finally), so the next call proceeds', async () => {
  const mutex = new Mutex();
  await assert.rejects(() => mutex.run(async () => { throw new Error('boom'); }), /boom/);
  let ran = false;
  await mutex.run(async () => { ran = true; });
  assert.equal(ran, true, 'a throw must not leak the lock');
});

test('release is idempotent — calling it twice does not corrupt the queue', async () => {
  const mutex = new Mutex();
  const release = await mutex.acquire();
  release();
  release(); // double release (resolve() is idempotent) — must be harmless
  let ran = false;
  await mutex.run(async () => { ran = true; });
  assert.equal(ran, true);
});

test('acquire() without release is a documented wedge: a second acquire never settles (no timeout)', async () => {
  const mutex = new Mutex();
  await mutex.acquire(); // intentionally never released
  let settled = false;
  void mutex.acquire().then(() => { settled = true; });
  await flush();
  // acquire() has no timeout, so the second acquire stays pending forever. This
  // documents the deferred leaked-lock failure mode — flip to assert.rejects with a
  // timeout error if/when acquire() grows a timeout.
  assert.equal(settled, false, 'second acquire must still be pending (no-timeout wedge)');
});

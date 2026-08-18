import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACQUIRE_TIMEOUT_MS, Mutex, MutexTimeoutError } from './mutex.js';

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

test('a leaked lock fails ONE waiter instead of wedging the LLM forever (#14)', async () => {
  // This used to be a passing characterization test asserting the opposite —
  // that the second acquire stays pending forever. The wedge was specified
  // behaviour, which is why nothing failed while every later LLM call died.
  const mutex = new Mutex({ timeoutMs: 20 });
  await mutex.acquire(); // intentionally never released, as a leaked lock is
  await assert.rejects(
    () => mutex.acquire(),
    (err: Error) => err instanceof MutexTimeoutError && /timed out/i.test(err.message),
    'a waiter behind a leaked lock must reject, and be identifiable as a timeout',
  );
});

test('run() surfaces the timeout too, so a wedged turn fails rather than hangs', async () => {
  const mutex = new Mutex({ timeoutMs: 20 });
  await mutex.acquire(); // leaked
  await assert.rejects(() => mutex.run(async () => 'never runs'), MutexTimeoutError);
});

test('a timed-out waiter does not let the NEXT waiter jump the still-held lock', async () => {
  // The subtle half. Each acquirer splices its own link into the queue, so a
  // waiter that gives up cannot simply resolve its link: everyone behind it
  // would be released while the original holder is still inside its critical
  // section. Timing out must yield the waiter's PLACE without granting the lock.
  const mutex = new Mutex({ timeoutMs: 20 });
  const releaseHolder = await mutex.acquire();

  await assert.rejects(() => mutex.acquire(), MutexTimeoutError);

  let thirdGotIt = false;
  const third = mutex.acquire().then((release) => {
    thirdGotIt = true;
    return release;
  });
  await flush();
  assert.equal(thirdGotIt, false, 'the holder still holds — nobody may pass');

  releaseHolder();
  const release = await third;
  assert.equal(thirdGotIt, true, 'once the holder releases, the queue drains past the casualty');
  release();
});

test('a slow but legitimate hold is not mistaken for a wedge', async () => {
  // The timeout must be a backstop, not a scheduler. A waiter that gets the
  // lock inside the window proceeds normally.
  const mutex = new Mutex({ timeoutMs: 200 });
  const release = await mutex.acquire();
  const queued = mutex.acquire();
  setTimeout(release, 20);
  const secondRelease = await queued;
  secondRelease();
});

test('the default timeout comfortably exceeds a legitimate LLM hold', async () => {
  // A chat may hold for LLM_TIMEOUT_MS (120s default) and a stream longer, so a
  // short default would turn queueing under load into spurious failures.
  assert.ok(
    DEFAULT_ACQUIRE_TIMEOUT_MS >= 300_000,
    `default acquire timeout ${DEFAULT_ACQUIRE_TIMEOUT_MS}ms must leave room for a real hold`,
  );
});

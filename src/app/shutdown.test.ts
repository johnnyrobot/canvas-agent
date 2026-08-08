import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerShutdown, type QuitEvent, type QuitHost } from './shutdown.js';

/** A QuitHost double: captures the listener so the test can fire `before-quit`. */
function fakeHost() {
  let listener: ((e: QuitEvent) => void) | undefined;
  const exits: number[] = [];
  const prevented: number[] = [];
  const host: QuitHost = {
    on(_event, l) {
      listener = l;
    },
    exit(code) {
      exits.push(code);
    },
  };
  return {
    host,
    exits,
    prevented,
    quit() {
      listener?.({ preventDefault: () => prevented.push(1) });
    },
  };
}

/** Resolve once the pending microtasks/timers have drained. */
const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('before-quit is prevented so teardown can run', async () => {
  const h = fakeHost();
  registerShutdown(h.host, async () => {});
  h.quit();
  await settle();
  assert.equal(h.prevented.length, 1);
});

test('dispose is awaited before the process exits', async () => {
  const order: string[] = [];
  const h = fakeHost();
  registerShutdown(h.host, async () => {
    await settle(5);
    order.push('disposed');
  });
  h.quit();
  await settle(50);
  order.push(`exit:${h.exits[0]}`);
  assert.deepEqual(order, ['disposed', 'exit:0']);
});

test('exits 0 on the happy path', async () => {
  const h = fakeHost();
  registerShutdown(h.host, async () => {});
  h.quit();
  await settle();
  assert.deepEqual(h.exits, [0]);
});

test('exits anyway when teardown exceeds the deadline', async () => {
  const h = fakeHost();
  registerShutdown(h.host, () => new Promise<void>(() => {}), { timeoutMs: 10, log: () => {} });
  h.quit();
  await settle(60);
  assert.deepEqual(h.exits, [0], 'a leaked sidecar beats an app that will not quit');
});

test('exits even when dispose rejects', async () => {
  const h = fakeHost();
  registerShutdown(h.host, async () => {
    throw new Error('stop failed');
  }, { log: () => {} });
  h.quit();
  await settle();
  assert.deepEqual(h.exits, [0]);
});

test('every before-quit is prevented, but teardown runs only once', async () => {
  let disposeCalls = 0;
  const h = fakeHost();
  registerShutdown(h.host, async () => {
    disposeCalls += 1;
    await settle(20);
  });
  h.quit();
  h.quit();
  h.quit();
  await settle(80);
  assert.equal(disposeCalls, 1, 'a second Cmd-Q must not restart teardown');
  assert.deepEqual(h.exits, [0]);
  assert.equal(
    h.prevented.length,
    3,
    'Electron re-emits before-quit on every quit attempt; each one must be prevented or the default quit races teardown',
  );
});

test('a repeat before-quit is prevented even though teardown already started', async () => {
  const h = fakeHost();
  registerShutdown(h.host, async () => {
    await settle(20);
  });
  h.quit();
  h.quit();
  assert.deepEqual(h.prevented, [1, 1], 'both quit attempts must be prevented, not just the first');
  await settle(60);
});

test('exits promptly (no leaked timer) when dispose rejects under the default timeout', async () => {
  const h = fakeHost();
  const start = performance.now();
  registerShutdown(h.host, async () => {
    throw new Error('stop failed');
  }, { log: () => {} });
  h.quit();
  await settle(30);
  assert.deepEqual(h.exits, [0]);
  assert.ok(
    performance.now() - start < 500,
    'a rejected dispose must not wait out the default 8s timeout — the timer must be cleared',
  );
});

test('the timeout path logs why it gave up', async () => {
  const logs: string[] = [];
  const h = fakeHost();
  registerShutdown(h.host, () => new Promise<void>(() => {}), {
    timeoutMs: 10,
    log: (m) => logs.push(m),
  });
  h.quit();
  await settle(60);
  assert.ok(logs.some((l) => /exceeded 10ms/.test(l)), `expected a timeout log, got ${JSON.stringify(logs)}`);
});

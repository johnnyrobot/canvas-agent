import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../contracts/index.js';
import { createLazyDatabase } from './database.js';

/** A Database double that records whether it was closed. */
function fakeDb(): Database & { closed: number } {
  return {
    closed: 0,
    exec: () => {},
    all: () => [],
    get: () => undefined,
    run: () => ({ changes: 0 }),
    close(this: { closed: number }) {
      this.closed += 1;
    },
  } as Database & { closed: number };
}

test('open() memoizes — two callers share one handle and one open', async () => {
  let opens = 0;
  const db = fakeDb();
  const lazy = createLazyDatabase({
    openImpl: async () => {
      opens += 1;
      return db;
    },
  });
  const [a, b] = await Promise.all([lazy.open(), lazy.open()]);
  assert.equal(opens, 1);
  assert.equal(a, db);
  assert.equal(b, db);
});

test('close() never opens a database that was never opened', async () => {
  let opens = 0;
  const lazy = createLazyDatabase({
    openImpl: async () => {
      opens += 1;
      return fakeDb();
    },
  });
  await lazy.close();
  assert.equal(opens, 0, 'shutdown must not open a file just to close it');
});

test('close() closes a handle that was opened', async () => {
  const db = fakeDb();
  const lazy = createLazyDatabase({ openImpl: async () => db });
  await lazy.open();
  await lazy.close();
  assert.equal(db.closed, 1);
});

test('close() is idempotent — a second call does not close twice', async () => {
  const db = fakeDb();
  const lazy = createLazyDatabase({ openImpl: async () => db });
  await lazy.open();
  await lazy.close();
  await lazy.close();
  assert.equal(db.closed, 1);
});

test('close() after a failed open resolves rather than rethrowing', async () => {
  const lazy = createLazyDatabase({
    openImpl: async () => {
      throw new Error('disk full');
    },
  });
  await assert.rejects(() => lazy.open(), /disk full/);
  await lazy.close(); // must not throw — there is nothing to close
});

test('close() surfaces a failure from the underlying close', async () => {
  const lazy = createLazyDatabase({
    openImpl: async () =>
      ({
        exec: () => {},
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0 }),
        close: () => {
          throw new Error('close failed');
        },
      }) as Database,
  });
  await lazy.open();
  await assert.rejects(() => lazy.close(), /close failed/);
});

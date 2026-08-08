/**
 * The on-device SQLite handle's lifetime, owned in one place (ADR-0006).
 *
 * `createAppApi` opened this lazily and nothing ever closed it, because it
 * returns an `AppApi` with no lifecycle members. Lifting open+close into one
 * object lets `createRuntime` hold it and close it on quit.
 *
 * `close()` is a NO-OP when `open()` was never called: a session that never
 * touched a session or brand kit never creates the file, and shutdown must not
 * open one just to close it.
 *
 * Once closed, the database stays closed: `close()` latches a `closed` flag
 * before anything else, so a later `open()` fails loudly instead of silently
 * opening a brand-new handle that nothing will ever close. And if `close()`
 * lands while an `open()` is still in flight, that `open()` call rejects
 * instead of resolving to a handle that `close()` has already (or is about
 * to) close out from under it — the caller gets a clear error, not a silent
 * use-after-close.
 */
import { ensureAppDirs, migrate, openDatabase, resolveAppPaths } from '../storage/index.js';
import type { Database } from '../contracts/index.js';

export interface LazyDatabase {
  open(): Promise<Database>;
  close(): Promise<void>;
}

export interface LazyDatabaseOptions {
  /** Test seam: open a database without touching the real app-data dir. */
  openImpl?: () => Promise<Database>;
}

/** The real on-device open: resolve paths, create dirs, open the file, migrate. */
async function openOnDevice(): Promise<Database> {
  const paths = resolveAppPaths();
  await ensureAppDirs(paths); // create the app-data dir before SQLite opens the file
  const db = await openDatabase(paths.dbPath);
  await migrate(db);
  return db;
}

export function createLazyDatabase(options: LazyDatabaseOptions = {}): LazyDatabase {
  const openImpl = options.openImpl ?? openOnDevice;
  let opening: Promise<Database> | undefined;
  let closed = false;

  return {
    open() {
      if (closed) {
        return Promise.reject(new Error('LazyDatabase is closed; the app is shutting down.'));
      }
      const pending = (opening ??= openImpl());
      return pending.then((db) => {
        if (closed) {
          throw new Error('LazyDatabase was closed while opening; the app is shutting down.');
        }
        return db;
      });
    },

    async close() {
      closed = true; // no new handles after this, even if we never opened one
      if (!opening) return; // never opened — nothing to close
      const pending = opening;
      opening = undefined; // idempotent: a second close finds nothing
      let db: Database;
      try {
        db = await pending;
      } catch {
        return; // the open failed, so there is no handle to close
      }
      await db.close();
    },
  };
}

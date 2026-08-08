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

  return {
    open() {
      return (opening ??= openImpl());
    },

    async close() {
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

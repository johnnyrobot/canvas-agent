/**
 * SQLite-backed `Database` port (PRD §3, §16). Thin, synchronous wrapper over
 * the `node:sqlite` built-in (`DatabaseSync`) — zero runtime dependencies.
 *
 * `node:sqlite` is experimental and prints a one-line warning on first use;
 * that is expected and acceptable (it is a Node built-in, so still zero deps).
 *
 * SECURITY: every value is passed as a *bound* parameter — never concatenated
 * into the SQL string.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Database, OpenDatabase } from '../contracts/index.js';

/** Cast the port's `readonly unknown[]` params to what `node:sqlite` binds. */
function bind(params?: readonly unknown[]): SQLInputValue[] {
  return (params ?? []) as SQLInputValue[];
}

/**
 * Open the app's SQLite database. `path` is `':memory:'` (tests) or a file
 * path. WAL journaling + foreign-key enforcement are enabled on open.
 */
export const openDatabase: OpenDatabase = (path: string): Database => {
  const db = new DatabaseSync(path);
  // WAL improves concurrent read/write on a real file; harmless (no-op) for
  // ':memory:'. Foreign keys are off by default in SQLite and must be enabled
  // per connection.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  return {
    exec(sql: string): void {
      db.exec(sql);
    },
    all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T[] {
      // node:sqlite hands back null-prototype rows; spread to ergonomic plain
      // objects so consumers can deep-compare / inspect them normally.
      return db.prepare(sql).all(...bind(params)).map((row) => ({ ...row })) as unknown as T[];
    },
    get<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): T | undefined {
      const row = db.prepare(sql).get(...bind(params));
      return row === undefined ? undefined : ({ ...row } as unknown as T);
    },
    run(sql: string, params?: readonly unknown[]): { changes: number } {
      const { changes } = db.prepare(sql).run(...bind(params));
      return { changes: Number(changes) };
    },
    close(): void {
      db.close();
    },
  };
};

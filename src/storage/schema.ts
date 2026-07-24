/**
 * Core application schema (PRD v1.6 §storage, HANDOFF §3.3). Idempotent:
 * every statement is `CREATE TABLE IF NOT EXISTS`, so `migrate` can run on
 * every app launch.
 *
 * SCOPE: this owns only the *core* app tables (projects / sessions / turns /
 * canvas imports / brand kits / meta). The knowledge track owns all `kb_*` and
 * FTS5 tables — they are intentionally NOT created here.
 */
import type { Database } from '../contracts/index.js';

/** Bump when the core schema changes; recorded in `meta.schema_version`. */
export const SCHEMA_VERSION = 4;

/**
 * The implicit single-user "home" project (PRD v1: single-user). Every session
 * is associated with it; `projectId` is deliberately NOT exposed in the
 * contract `Session`. The session store inserts sessions against this id.
 */
export const DEFAULT_PROJECT_ID = 'default';

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  // `title` / `mode` / `updated_at` were added after v1. Fresh DBs get them
  // here; pre-existing v1 DBs are upgraded in place by the guarded ALTERs below.
  `CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title      TEXT,
    mode       TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,

  // `fragments` (JSON of the turn's gated HTML fragments) was added after v1.
  // Fresh DBs get it here; pre-existing DBs are upgraded by the guarded ALTER below.
  `CREATE TABLE IF NOT EXISTS turns (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    fragments  TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS canvas_imports (
    course_id    TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    imported_at  TEXT NOT NULL,
    summary_json TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS brand_kits (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    primary_color   TEXT NOT NULL,
    secondary_color TEXT NOT NULL,
    font_heading    TEXT,
    font_body       TEXT,
    font_mono       TEXT,
    created_at      TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // v4: audit trail of opt-in Canvas publishes (PRD §17 — what was pushed,
  // where, when, and the SHA-256 of the exact HTML that went out).
  `CREATE TABLE IF NOT EXISTS canvas_publishes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id    TEXT NOT NULL,
    page_id      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    canvas_url   TEXT NOT NULL,
    published_at TEXT NOT NULL
  )`,

  // Helpful lookup indexes for the parent→child relations.
  `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)`,
];

/**
 * Columns added after v1. Each is applied as a guarded `ALTER TABLE … ADD COLUMN`
 * so an already-upgraded table (where the column exists, including every fresh DB)
 * is a harmless no-op. The table/column/type are compile-time constants — never
 * user input — so this DDL is safe.
 */
const COLUMN_ADDITIONS: ReadonlyArray<readonly [table: string, name: string, type: string]> = [
  ['sessions', 'title', 'TEXT'],
  ['sessions', 'mode', 'TEXT'],
  ['sessions', 'updated_at', 'TEXT'],
  // v3: persist a turn's gated HTML fragments so resume restores the work product.
  ['turns', 'fragments', 'TEXT'],
];

/** SQLite raises "duplicate column name: X" when the column already exists. */
function isDuplicateColumnError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /duplicate column name/i.test(message);
}

/** Add a column, treating an already-present column as a no-op. */
async function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    if (!isDuplicateColumnError(err)) throw err;
  }
}

/**
 * Apply the idempotent core schema and stamp the current schema version.
 * Safe to call repeatedly (e.g. on every startup) and on both fresh and
 * pre-existing v1 databases.
 */
export async function migrate(db: Database): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.exec(sql);
  }
  // Upgrade pre-existing tables in place (no-op on fresh DBs / already-upgraded ones).
  for (const [table, column, type] of COLUMN_ADDITIONS) {
    await addColumnIfMissing(db, table, column, type);
  }
  // Ensure the implicit single-user default project exists (insert-if-missing).
  await db.run(
    `INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [DEFAULT_PROJECT_ID, 'Default', new Date().toISOString()],
  );
  // Record / refresh the schema version (parameterized, upserted).
  await db.run(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(SCHEMA_VERSION)],
  );
}

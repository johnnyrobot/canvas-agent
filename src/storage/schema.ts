/**
 * Core application schema (PRD v1.6 §storage, HANDOFF §3.3). Idempotent:
 * every statement is `CREATE TABLE IF NOT EXISTS`, so `migrate` can run on
 * every app launch.
 *
 * SCOPE: this owns only the *core* app tables (projects / sessions / turns /
 * canvas imports / meta). The knowledge track owns all `kb_*` and FTS5 tables —
 * they are intentionally NOT created here.
 */
import type { Database } from '../contracts/index.js';

/** Bump when the core schema changes; recorded in `meta.schema_version`. */
export const SCHEMA_VERSION = 1;

const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS turns (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS canvas_imports (
    course_id    TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    imported_at  TEXT NOT NULL,
    summary_json TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Helpful lookup indexes for the parent→child relations.
  `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)`,
];

/**
 * Apply the idempotent core schema and stamp the current schema version.
 * Safe to call repeatedly (e.g. on every startup).
 */
export async function migrate(db: Database): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.exec(sql);
  }
  // Record / refresh the schema version (parameterized, upserted).
  await db.run(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(SCHEMA_VERSION)],
  );
}

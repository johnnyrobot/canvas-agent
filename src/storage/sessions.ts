/**
 * Session persistence on the `Database` port (PRD product layer: sessions).
 *
 * A session is a saved working transcript: its metadata lives in `sessions`,
 * its messages in `turns` (role + content, in append order). The runtime track
 * (T4) persists/loads turns through this store. v1 is single-user, so every
 * session is associated with the implicit `default` project — `projectId` is
 * deliberately NOT surfaced in the contract `Session`.
 *
 * SECURITY: every value is passed as a *bound* parameter — never concatenated
 * into the SQL string.
 */
import { randomUUID } from 'node:crypto';
import type {
  Database,
  ProductMode,
  Session,
  SessionMessage,
  SessionState,
} from '../contracts/index.js';
import { DEFAULT_PROJECT_ID } from './schema.js';

export interface SessionStore {
  /** All sessions, newest *updated* first. */
  listSessions(): Promise<Session[]>;
  /** A session plus its resumable transcript, or `null` if unknown. */
  loadSession(id: string): Promise<SessionState | null>;
  /** Create a new (empty) session under the default project. */
  createSession(init: { title: string; mode: ProductMode }): Promise<Session>;
  /** Append messages to a session's transcript; bumps `updated_at`. */
  appendMessages(sessionId: string, messages: SessionMessage[]): Promise<void>;
  /** Delete a session; its turns cascade away (FK `ON DELETE CASCADE`). */
  deleteSession(id: string): Promise<void>;
}

/** Shape of a `sessions` row (columns added after v1 are nullable). */
interface SessionRow {
  id: string;
  title: string | null;
  mode: string | null;
  created_at: string;
  updated_at: string | null;
}

/** Shape of the `turns` columns we read back as messages. */
interface TurnRow {
  role: string;
  content: string;
}

const SESSION_COLUMNS = 'id, title, mode, created_at, updated_at';

/** Map a DB row → the contract `Session`, defensively defaulting nullables. */
function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title ?? '',
    mode: (row.mode ?? 'guidance') as ProductMode,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

export function createSessionStore(db: Database): SessionStore {
  return {
    async listSessions(): Promise<Session[]> {
      const rows = await db.all<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions
         ORDER BY updated_at DESC, created_at DESC, rowid DESC`,
      );
      return rows.map(toSession);
    },

    async loadSession(id: string): Promise<SessionState | null> {
      const row = await db.get<SessionRow>(
        `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`,
        [id],
      );
      if (row === undefined) return null;
      // `rowid` (insertion order) is the tiebreaker so messages appended within
      // the same millisecond still load in the exact order they were written.
      const turns = await db.all<TurnRow>(
        `SELECT role, content FROM turns WHERE session_id = ?
         ORDER BY created_at ASC, rowid ASC`,
        [id],
      );
      const messages: SessionMessage[] = turns.map((t) => ({
        role: t.role as SessionMessage['role'],
        content: t.content,
      }));
      return { session: toSession(row), messages };
    },

    async createSession(init: { title: string; mode: ProductMode }): Promise<Session> {
      const id = randomUUID();
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO sessions (id, project_id, title, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, DEFAULT_PROJECT_ID, init.title, init.mode, now, now],
      );
      return { id, title: init.title, mode: init.mode, createdAt: now, updatedAt: now };
    },

    async appendMessages(sessionId: string, messages: SessionMessage[]): Promise<void> {
      const now = new Date().toISOString();
      for (const message of messages) {
        await db.run(
          `INSERT INTO turns (id, session_id, role, content, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [randomUUID(), sessionId, message.role, message.content, now],
        );
      }
      // A new message makes the session the most recently touched.
      await db.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [now, sessionId]);
    },

    async deleteSession(id: string): Promise<void> {
      await db.run(`DELETE FROM sessions WHERE id = ?`, [id]);
    },
  };
}

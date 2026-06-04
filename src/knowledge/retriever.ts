/**
 * Lexical/structured retrieval over Knowledge Packs (PRD §13.1). NO embeddings.
 *
 * `createRetriever` builds an in-memory SQLite FTS5 index over the units of the
 * loaded packs and returns a `KbRetriever`. Retrieval is:
 *   1. Rubric-ID routing (structured): if the query leads with a rubric/criterion
 *      id (see `RUBRIC_ID_PATTERN`), short-circuit to a direct id lookup.
 *   2. Otherwise BM25 lexical ranking via FTS5, with optional intent scoping to
 *      a subset of pack ids.
 *
 * The index build is intentionally isolated (all SQL is local to this module) so
 * a future change can swap the in-memory store for an injected persistent
 * `Database` (storage track) without touching the public surface.
 */
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadPack, loadPacksDir, type KnowledgePack } from './pack.js';
import type { KbHit, KbResult, KbRetriever } from '../contracts/index.js';

export interface RetrieverOptions {
  /** Pre-loaded packs to index. Takes precedence over `dir`. */
  packs?: KnowledgePack[];
  /** Directory of `*.json` packs to load. Defaults to the bundled packs dir. */
  dir?: string;
  /** Maximum number of hits to return per query. Default 5. */
  limit?: number;
}

/**
 * Structured rubric/criterion id pattern (PRD §13.1 rubric-ID routing). One to
 * four leading uppercase letters, an optional hyphen, then digits — e.g.
 * `RUB-3`, `A11Y-12`, `R7`. A query whose leading token matches is routed to a
 * direct id lookup before any lexical search. Routing itself is case-insensitive
 * (the query is upper-cased first); the pattern documents the canonical form.
 */
export const RUBRIC_ID_PATTERN = /^[A-Z]{1,4}-?\d+/;

const DEFAULT_LIMIT = 5;
/** Score given to an exact structured (rubric-ID) match — above any BM25 score. */
const EXACT_MATCH_SCORE = 1000;
/** Heading matches count more than body matches. Stable across SELECT + ORDER BY. */
const BM25 = 'bm25(units, 10.0, 1.0)';

const DEFAULT_PACKS_DIR = fileURLToPath(new URL('./packs', import.meta.url));

interface UnitRow {
  packId: string;
  unitId: string;
  title: string;
  text: string;
  citation: string;
  /** Raw BM25 rank (only set on FTS rows; 0 for structured/rubric rows). */
  rank: number;
}

function asString(value: unknown): string {
  return value == null ? '' : String(value);
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Convert a raw user query into a safe FTS5 MATCH expression. FTS5 has its own
 * query grammar (`"`, `*`, `:`, `OR`, `(`, ...) so a raw query can throw. We keep
 * only letters/digits, wrap each surviving term as a quoted phrase, and OR them
 * for recall — BM25 handles precision. Returns `''` when nothing is searchable.
 */
function toFtsMatch(raw: string): string {
  const terms = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return '';
  return terms.map((term) => `"${term}"`).join(' OR ');
}

function toHit(row: UnitRow, score: number): KbHit {
  return {
    id: `${row.packId}:${row.unitId}`,
    packId: row.packId,
    title: row.title,
    snippet: row.text,
    score,
    citation: row.citation,
  };
}

function rowFrom(record: Record<string, unknown>): UnitRow {
  return {
    packId: asString(record.packId),
    unitId: asString(record.unitId),
    title: asString(record.title),
    text: asString(record.text),
    citation: asString(record.citation),
    rank: record.rank === undefined ? 0 : asNumber(record.rank),
  };
}

function resolvePacks(opts: RetrieverOptions | undefined): KnowledgePack[] {
  if (opts?.packs) return opts.packs.map((p) => loadPack(p));
  if (opts?.dir) return loadPacksDir(opts.dir);
  return loadPacksDir(DEFAULT_PACKS_DIR);
}

/**
 * Build a `KbRetriever` over the loaded packs. The optional `packs` arg to the
 * returned function scopes retrieval to those pack ids (intent scoping); higher
 * `score` means more relevant.
 */
export function createRetriever(opts?: RetrieverOptions): KbRetriever {
  const packs = resolvePacks(opts);
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE units USING fts5(
    heading,
    text,
    pack_id UNINDEXED,
    unit_id UNINDEXED,
    title UNINDEXED,
    citation UNINDEXED
  );`);

  const insert = db.prepare(
    `INSERT INTO units(heading, text, pack_id, unit_id, title, citation)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const pack of packs) {
    for (const unit of pack.units) {
      insert.run(unit.heading, unit.text, pack.id, unit.id, pack.title, unit.citation);
    }
  }

  function scopeClause(scoped: string[] | undefined): { sql: string; params: string[] } {
    if (!scoped) return { sql: '', params: [] };
    const placeholders = scoped.map(() => '?').join(', ');
    return { sql: ` AND pack_id IN (${placeholders})`, params: scoped };
  }

  function routeRubric(query: string, scoped: string[] | undefined): KbHit[] {
    const id = query.trim().toUpperCase();
    if (!RUBRIC_ID_PATTERN.test(id)) return [];
    const matched = id.match(RUBRIC_ID_PATTERN);
    if (!matched) return [];
    const scope = scopeClause(scoped);
    const rows = db
      .prepare(
        `SELECT pack_id AS packId, unit_id AS unitId, title, text, citation
         FROM units
         WHERE UPPER(unit_id) = ?${scope.sql}
         ORDER BY pack_id, unit_id`,
      )
      .all(matched[0], ...scope.params) as Record<string, unknown>[];
    return rows.slice(0, limit).map((r) => toHit(rowFrom(r), EXACT_MATCH_SCORE));
  }

  function searchFts(query: string, scoped: string[] | undefined): KbHit[] {
    const match = toFtsMatch(query);
    if (match === '') return [];
    const scope = scopeClause(scoped);
    const rows = db
      .prepare(
        `SELECT pack_id AS packId, unit_id AS unitId, title, text, citation, ${BM25} AS rank
         FROM units
         WHERE units MATCH ?${scope.sql}
         ORDER BY ${BM25}
         LIMIT ?`,
      )
      .all(match, ...scope.params, limit) as Record<string, unknown>[];
    return rows.map((r) => {
      const row = rowFrom(r);
      // BM25 is negative (more negative = better); flip so higher = more relevant.
      const score = Math.round(-row.rank * 1e6) / 1e6;
      return toHit(row, score);
    });
  }

  return async function retrieve(query: string, scopedPacks?: string[]): Promise<KbResult> {
    // Scoping to zero packs is explicit and yields nothing.
    if (scopedPacks && scopedPacks.length === 0) return { hits: [] };

    const routed = routeRubric(query, scopedPacks);
    if (routed.length > 0) return { hits: routed };

    return { hits: searchFts(query, scopedPacks) };
  };
}

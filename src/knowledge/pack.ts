/**
 * Knowledge Pack format + loaders (PRD §9.2).
 *
 * A pack is a small, hand-authored JSON file of citable "units". Packs are the
 * only knowledge source for v1 retrieval — lexical/structured, NO embeddings.
 * `loadPack` validates + normalizes a single pack (from a path or a parsed
 * object); `loadPacksDir` loads every `*.json` pack in a directory.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One citable snippet of knowledge inside a pack. */
export interface KnowledgeUnit {
  /** Stable id, unique within its pack. May double as a rubric/criterion id. */
  id: string;
  /** Short heading (weighted higher at retrieval time). May be empty. */
  heading: string;
  /** The body text that gets indexed and returned as the hit snippet. */
  text: string;
  /** Stable citation string surfaced to the user (PRD §13.1). */
  citation: string;
}

/** A loaded, validated Knowledge Pack. */
export interface KnowledgePack {
  /** Stable pack id, unique across loaded packs. */
  id: string;
  /** Human-readable pack title (returned on every hit). */
  title: string;
  /** Intent tags used for intent scoping (e.g. "accessibility", "audit"). */
  intents: string[];
  /** The citable units. Always at least one. */
  units: KnowledgeUnit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Knowledge pack ${where}: "${field}" must be a non-empty string`);
  }
  return value.trim();
}

function normalizeIntents(value: unknown, where: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Knowledge pack ${where}: "intents" must be an array of strings`);
  }
  return value.map((intent, i) => requireString(intent, `intents[${i}]`, where));
}

function normalizeUnit(value: unknown, packId: string, index: number): KnowledgeUnit {
  const where = `${packId}.units[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`Knowledge pack ${where}: each unit must be an object`);
  }
  const heading = value.heading === undefined ? '' : requireOptionalString(value.heading, 'heading', where);
  return {
    id: requireString(value.id, 'id', where),
    heading,
    text: requireString(value.text, 'text', where),
    citation: requireString(value.citation, 'citation', where),
  };
}

function requireOptionalString(value: unknown, field: string, where: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Knowledge pack ${where}: "${field}" must be a string`);
  }
  return value.trim();
}

/**
 * Validate + normalize a single pack. `source` is either a filesystem path to a
 * JSON pack or an already-parsed object. Throws on any structural problem.
 */
export function loadPack(source: string | unknown): KnowledgePack {
  let raw: unknown = source;
  if (typeof source === 'string') {
    const text = readFileSync(source, 'utf8');
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`Knowledge pack at ${source}: invalid JSON (${(err as Error).message})`);
    }
  }

  if (!isRecord(raw)) {
    throw new Error('Knowledge pack: top-level value must be an object');
  }

  const id = requireString(raw.id, 'id', '<root>');
  const title = requireString(raw.title, 'title', id);
  const intents = normalizeIntents(raw.intents, id);

  if (!Array.isArray(raw.units) || raw.units.length === 0) {
    throw new Error(`Knowledge pack ${id}: "units" must be a non-empty array`);
  }

  const units = raw.units.map((u, i) => normalizeUnit(u, id, i));

  const seen = new Set<string>();
  for (const unit of units) {
    if (seen.has(unit.id)) {
      throw new Error(`Knowledge pack ${id}: duplicate unit id "${unit.id}"`);
    }
    seen.add(unit.id);
  }

  return { id, title, intents, units };
}

/**
 * Load every `*.json` pack in `dir`, sorted by filename for deterministic order.
 * Throws if two packs share an id.
 */
export function loadPacksDir(dir: string): KnowledgePack[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const packs: KnowledgePack[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const pack = loadPack(join(dir, file));
    if (ids.has(pack.id)) {
      throw new Error(`Knowledge packs in ${dir}: duplicate pack id "${pack.id}" (${file})`);
    }
    ids.add(pack.id);
    packs.push(pack);
  }
  return packs;
}

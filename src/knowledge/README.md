# knowledge — Knowledge Packs + lexical retrieval

v1 knowledge retrieval for the Canvas assistant (PRD §9.2, §13.1). Intent-scoped
**Knowledge Packs** + **lexical/structured** retrieval. **NO embeddings** — vector
search is explicitly out of scope for v1 (PRD §3.4 / HANDOFF §5). Zero runtime
dependencies: the index is built on Node's built-in `node:sqlite` (FTS5 + `bm25`).

## Public surface (`index.ts`)

```ts
import { createRetriever, loadPack, loadPacksDir, RUBRIC_ID_PATTERN } from './knowledge/index.js';
import type { KbRetriever, KbResult, KbHit, KnowledgePack } from './knowledge/index.js';

const retrieve: KbRetriever = createRetriever();        // loads bundled packs/
const { hits } = await retrieve('color contrast ratio'); // BM25-ranked KbHit[]
const scoped = await retrieve('overview', ['canvas-templates']); // intent scoping
```

`createRetriever` implements the frozen `KbRetriever` port from `src/contracts`:
`(query: string, packs?: string[]) => Promise<KbResult>`. Higher `score` = more
relevant.

### `createRetriever(opts?)`

| option   | meaning                                                          |
| -------- | --------------------------------------------------------------- |
| `packs`  | pre-loaded `KnowledgePack[]` to index (takes precedence)        |
| `dir`    | directory of `*.json` packs to load                             |
| `limit`  | max hits per query (default 5)                                  |

With no options it loads the bundled `packs/` directory.

## Knowledge Pack format (`pack.ts`)

A pack is a small hand-authored JSON file of citable **units**:

```jsonc
{
  "id": "wcag-basics",
  "title": "WCAG 2.2 AA Essentials",
  "intents": ["accessibility", "audit"],   // for intent scoping
  "units": [
    {
      "id": "contrast",                     // unique within the pack; may be a rubric id
      "heading": "Color contrast",          // weighted higher at retrieval time (optional)
      "text": "Body text must have a contrast ratio of at least 4.5 to 1 …",
      "citation": "WCAG 2.2 §1.4.3"         // surfaced verbatim on every hit
    }
  ]
}
```

- `loadPack(pathOrObject)` validates + normalizes one pack (trims strings, defaults
  `intents` to `[]` and `heading` to `""`, rejects empty ids / no units / duplicate
  unit ids).
- `loadPacksDir(dir)` loads every `*.json` pack, filename-sorted (deterministic),
  rejecting duplicate pack ids.

Bundled sample packs: `wcag-basics`, `canvas-templates`, `rubric-criteria`.

## Retrieval (`retriever.ts`)

1. **Rubric-ID routing (structured).** If the query leads with a rubric/criterion
   id matching `RUBRIC_ID_PATTERN` = `^[A-Z]{1,4}-?\d+` (e.g. `RUB-3`, `A11Y-12`,
   `R7`), the query short-circuits to a direct, case-insensitive `unit_id` lookup
   before any lexical search. An unmatched id falls back to FTS.
2. **Lexical BM25 (default).** Units are inserted into an in-memory FTS5 virtual
   table (`heading`, `text` indexed; `pack_id`, `unit_id`, `title`, `citation`
   stored `UNINDEXED`). Queries run `… WHERE units MATCH ? ORDER BY bm25(units,
   10.0, 1.0)` (heading weighted 10×). BM25 is negative (more-negative = better);
   the returned `score` is `-bm25` so higher = more relevant.
3. **Intent scoping.** When `packs` is given, results are restricted with
   `AND pack_id IN (?, …)` (bound params). Scoping to zero packs yields `[]`.

### Query sanitization

FTS5 has its own query grammar (`"`, `*`, `:`, `OR`, `(`, …), so a raw user query
can throw. `toFtsMatch` keeps only letters/digits, wraps each surviving term as a
quoted phrase, and ORs them for recall (BM25 handles precision). A query that
reduces to nothing (empty / all-punctuation) returns `{ hits: [] }`. **All SQL is
parameterized** (`MATCH ?`, bound pack ids) — no string interpolation of user input.

## Future swap

`createRetriever` builds its own in-memory index for v1. All SQL is isolated in
`retriever.ts` so a later change can inject a persistent `Database` (storage track,
`src/contracts`) without changing this public surface. There is **no** dependency
on the storage track today.

## Tests

`node:test` + `tsx`, zero-dep. `npm test`. Covers deterministic ranking, pack
scoping, citations, rubric-ID routing (incl. case-insensitivity + fallback),
FTS special-character sanitization, and empty/no-match queries.

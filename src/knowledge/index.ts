/**
 * Knowledge — public surface.
 *
 * Knowledge Packs + lexical/structured retrieval for v1 (PRD §9.2, §13.1).
 * Retrieval is BM25 / SQLite FTS5 + rubric-ID routing — NO embeddings. The
 * single port consumed by the rest of the app is `KbRetriever` (from
 * `src/contracts`); `createRetriever` builds one over the loaded packs.
 */
export { createRetriever, RUBRIC_ID_PATTERN } from './retriever.js';
export type { RetrieverOptions } from './retriever.js';
export { loadPack, loadPacksDir } from './pack.js';
export type { KnowledgePack, KnowledgeUnit } from './pack.js';
export type { KbHit, KbResult, KbRetriever } from '../contracts/index.js';

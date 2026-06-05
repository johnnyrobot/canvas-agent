/**
 * canvas — read-only Canvas course import (PRD §17). Public surface.
 *
 * Implements the frozen `CanvasImporter` port from `src/contracts`. Performs a
 * READ-ONLY crawl (HTTP GET only, enforced in `http.ts`) of a Canvas course and
 * returns a `CanvasImportResult` summary. The source course is never mutated.
 *
 *   - `importCourse`    — the default importer (global `fetch` + system clock).
 *   - `createImporter`  — DI factory: inject a `fetch` and/or `now()` clock.
 *   - `fetchPageBody` / `listPages` — read-only page access for Remediate (T4).
 *   - `createPageReader` — DI factory for the page readers (inject a `fetch`).
 *   - `createCanvasGet` / `parseLinkNext` — the read-only transport primitives.
 */
import { createImporter } from './importer.js';
import { createPageReader, fetchPageBody, listPages } from './pages.js';
import { createCanvasGet, parseLinkNext } from './http.js';
import type { CanvasImporter } from '../contracts/index.js';

export { createImporter, createPageReader, fetchPageBody, listPages, createCanvasGet, parseLinkNext };
export type { ImporterOptions } from './importer.js';
export type { PageReader, PageReaderOptions } from './pages.js';
export type { CanvasGet, CanvasGetOptions, FetchLike } from './http.js';
export type { CanvasConfig, CanvasImportResult, CanvasImporter, CanvasPage } from '../contracts/index.js';

/** The default read-only importer, wired to the global `fetch` and system clock. */
export const importCourse: CanvasImporter = createImporter();

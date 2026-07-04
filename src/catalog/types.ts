/**
 * Types for the catalog adapter (LACCD eLumen public course catalog, via the
 * locally installed `laccd-courses-pp-cli`). See `README.md` for the CLI
 * contract and why this is an OPTIONAL enrichment source.
 *
 * `CatalogCourseSummary`/`CatalogCourse` are FROZEN cross-track contract types
 * (canonically defined in `src/contracts`, mirroring how `src/canvas`
 * re-exports `CanvasPage`/`CanvasImportResult`) — re-exported here so callers
 * within this module can `import from './types.js'` without reaching into
 * `../contracts` directly.
 */
export type { CatalogCourseSummary, CatalogCourse } from '../contracts/index.js';

/**
 * The kinds of failure `createCatalogClient` distinguishes, so callers (IPC
 * handlers, UI) can react appropriately instead of treating every failure the
 * same:
 *  - `notFound`    — the course/query id does not exist in the catalog.
 *  - `rateLimited` — the public eLumen API throttled this request.
 *  - `unavailable` — the CLI binary could not be resolved/run at all.
 *  - `parse`       — the CLI's JSON (outer envelope or the nested
 *                    `fullCourseInfo` string) could not be parsed.
 *  - `timeout`     — the invocation exceeded its time budget and was killed.
 *  - `cliError`    — any other non-zero exit (a genuine upstream API error,
 *                    a CLI usage error, etc.) that doesn't fit a more specific kind.
 */
export type CatalogErrorKind = 'notFound' | 'rateLimited' | 'unavailable' | 'parse' | 'timeout' | 'cliError';

/** A typed error from the catalog adapter — callers should branch on `.kind`, not parse `.message`. */
export class CatalogError extends Error {
  readonly kind: CatalogErrorKind;

  constructor(kind: CatalogErrorKind, message: string) {
    super(message);
    this.name = 'CatalogError';
    this.kind = kind;
  }
}

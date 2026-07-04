/**
 * catalog — LACCD eLumen course-catalog enrichment (OPTIONAL). Public surface.
 *
 * A read-only adapter around the locally installed `laccd-courses-pp-cli`
 * binary. See `README.md` for the CLI contract and why this degrades
 * gracefully when the CLI isn't installed.
 *
 *   - `createCatalogClient` — DI factory: inject a `command` path and/or `execFile`.
 *   - `CatalogError`        — typed failure (`.kind`): notFound/rateLimited/unavailable/parse/timeout/cliError.
 */
export { createCatalogClient } from './client.js';
export type { CatalogClient, CatalogClientOptions, ExecFileLike, CliExecResult, CliExecError } from './client.js';
export { CatalogError } from './types.js';
export type { CatalogErrorKind, CatalogCourseSummary, CatalogCourse } from './types.js';

/**
 * Read-only Canvas course importer (PRD §17) — implements the frozen
 * `CanvasImporter` port from `src/contracts`.
 *
 * `createImporter({ fetch, now })` returns an importer that crawls a course via
 * the Canvas REST API using ONLY HTTP GET (enforced by `createCanvasGet`) and
 * returns a `CanvasImportResult` summary. A forbidden/failed sub-resource (e.g.
 * `/files` → 403) degrades to a `warnings` entry and a count of 0 rather than
 * failing the whole import. The source course is never modified.
 */
import type {
  CanvasConfig,
  CanvasImporter,
  CanvasImportResult,
} from '../contracts/index.js';
import { createCanvasGet, parseLinkNext, sameOrigin } from './http.js';
import type { CanvasGet, FetchLike } from './http.js';

export interface ImporterOptions {
  /** Transport. Defaults to the global `fetch`; tests inject a recording fake. */
  fetch?: FetchLike;
  /**
   * Clock returning an ISO-8601 timestamp for `importedAt`. Defaults to
   * `() => new Date().toISOString()` — invoked only on the real import path, so
   * no wall-clock call happens at module load or in tests (which inject `now`).
   */
  now?: () => string;
}

/** Canvas caps `per_page`; 100 is the documented maximum for list endpoints. */
const PER_PAGE = 100;
/** Defensive bound on pages followed per list endpoint (anti-runaway). */
const MAX_PAGES = 1000;

/** Build a read-only `CanvasImporter`. */
export function createImporter(opts: ImporterOptions = {}): CanvasImporter {
  const fetchImpl = opts.fetch;
  const now = opts.now ?? (() => new Date().toISOString());

  return async function importCourse(
    config: CanvasConfig,
    courseId: string,
  ): Promise<CanvasImportResult> {
    const get = createCanvasGet({
      token: config.token,
      baseUrl: config.baseUrl,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const base = config.baseUrl.replace(/\/+$/, '');
    const courseRoot = `${base}/api/v1/courses/${encodeURIComponent(courseId)}`;
    const warnings: string[] = [];

    const name = await fetchCourseName(get, courseRoot, courseId, warnings);
    const pages = await countList(get, `${courseRoot}/pages`, 'pages', warnings);
    const assignments = await countList(get, `${courseRoot}/assignments`, 'assignments', warnings);
    const files = await countList(get, `${courseRoot}/files`, 'files', warnings);

    return {
      courseId,
      name,
      importedAt: now(),
      pages,
      assignments,
      files,
      warnings,
    };
  };
}

/**
 * Fetch the course's display name. The course is the identity of the import, so
 * an unreadable course (non-2xx) aborts the whole import — there is no
 * meaningful partial summary without it.
 */
async function fetchCourseName(
  get: CanvasGet,
  courseRoot: string,
  courseId: string,
  warnings: string[],
): Promise<string> {
  const res = await get(courseRoot);
  if (!res.ok) {
    throw new Error(
      `Canvas course ${courseId} could not be read (HTTP ${res.status}); aborting read-only import`,
    );
  }
  const body = (await res.json()) as { name?: unknown };
  if (typeof body?.name === 'string' && body.name.length > 0) return body.name;
  warnings.push('course: response had no "name" field; using empty name');
  return '';
}

/**
 * Count the items of a paginated list endpoint, following `Link: rel="next"`.
 * A non-2xx page records a warning and stops (partial count) instead of
 * throwing. If the cap is hit while more pages remain, a truncation warning is
 * pushed so the count is never silently short.
 */
async function countList(
  get: CanvasGet,
  endpoint: string,
  label: string,
  warnings: string[],
): Promise<number> {
  let url: string | null = `${endpoint}?per_page=${PER_PAGE}`;
  let count = 0;
  let pagesFollowed = 0;

  while (url) {
    const res = await get(url);
    if (!res.ok) {
      warnings.push(
        `${label}: skipped (HTTP ${res.status}); counted ${count} item(s) before the error`,
      );
      break;
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      warnings.push(`${label}: expected a JSON array but got ${typeof data}; counted ${count}`);
      break;
    }
    count += data.length;

    let next = parseLinkNext(res.headers.get('link'));
    // Defense in depth: a cross-origin `next` (a hostile/misconfigured Canvas
    // could emit one) ends pagination instead of sending the Bearer token to
    // another host. The get() backstop would also refuse it, but stopping here
    // keeps a completed partial count rather than throwing the whole import.
    if (next && !sameOrigin(next, endpoint)) {
      warnings.push(
        `${label}: stopped at a cross-origin pagination link (counted ${count}); the token is never sent off-origin`,
      );
      next = null;
    }
    pagesFollowed += 1;
    if (next && pagesFollowed >= MAX_PAGES) {
      warnings.push(
        `${label}: truncated at ${MAX_PAGES} pages (counted ${count}); more pages remain`,
      );
      break;
    }
    url = next;
  }
  return count;
}

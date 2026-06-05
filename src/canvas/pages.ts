/**
 * Read-only Canvas *page* access (PRD §17, Remediate import source).
 *
 * Two GET-only reads layered on the same transport as the importer:
 *   - `fetchPageBody` — a single page's body HTML, so Remediate mode can import
 *     existing Canvas content to repair. Returns '' when the page has no body.
 *   - `listPages`     — every page in a course (Link-header paginated, `MAX_PAGES`
 *     capped), mapped to the frozen `CanvasPage` descriptor.
 *
 * Like the importer, every request goes through `createCanvasGet`, the single
 * choke point that hard-codes `method: 'GET'` and THROWS on any other method, so
 * no write can ever reach Canvas. The token (from `config`, ultimately the
 * Keychain `SecretStore`) is sent as `Bearer` and never logged or persisted.
 *
 * Any HTML returned here is UNTRUSTED: it is gated by the runtime before render.
 * This module neither sanitizes nor trusts it.
 */
import type { CanvasConfig, CanvasPage } from '../contracts/index.js';
import { createCanvasGet, parseLinkNext } from './http.js';
import type { CanvasGet, FetchLike } from './http.js';

export interface PageReaderOptions {
  /** Transport. Defaults to the global `fetch`; tests inject a recording fake. */
  fetch?: FetchLike;
}

/** Canvas caps `per_page`; 100 is the documented maximum for list endpoints. */
const PER_PAGE = 100;
/** Defensive bound on pages followed per list endpoint (anti-runaway). */
const MAX_PAGES = 1000;

/** A bound pair of read-only page readers, sharing one injected transport. */
export interface PageReader {
  /** GET a single page's body HTML. Read-only. Returns '' if the page has no body. */
  fetchPageBody(config: CanvasConfig, courseId: string, pageId: string): Promise<string>;
  /** GET all pages in a course (paginated), mapped to CanvasPage. Read-only. */
  listPages(config: CanvasConfig, courseId: string): Promise<CanvasPage[]>;
}

/** Build read-only page readers over an injectable `fetch`. */
export function createPageReader(opts: PageReaderOptions = {}): PageReader {
  const fetchImpl = opts.fetch;

  /** One read-only GET client per config (token may differ per call). */
  function clientFor(config: CanvasConfig): { get: CanvasGet; base: string } {
    const get = createCanvasGet({
      token: config.token,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const base = config.baseUrl.replace(/\/+$/, '');
    return { get, base };
  }

  return {
    async fetchPageBody(config, courseId, pageId): Promise<string> {
      const { get, base } = clientFor(config);
      const url = `${base}/api/v1/courses/${encodeURIComponent(courseId)}/pages/${encodeURIComponent(pageId)}`;

      const res = await get(url);
      if (!res.ok) {
        throw new Error(
          `Canvas page "${pageId}" in course ${courseId} could not be read (HTTP ${res.status})`,
        );
      }
      const data = (await res.json()) as { body?: unknown };
      return typeof data?.body === 'string' ? data.body : '';
    },

    async listPages(config, courseId): Promise<CanvasPage[]> {
      const { get, base } = clientFor(config);
      const endpoint = `${base}/api/v1/courses/${encodeURIComponent(courseId)}/pages`;
      const pages: CanvasPage[] = [];
      let url: string | null = `${endpoint}?per_page=${PER_PAGE}`;
      let pagesFollowed = 0;

      while (url) {
        const res = await get(url);
        // Graceful degradation (matching the importer): a forbidden/failed list
        // stops with whatever was collected — [] on a first-page error — never throws.
        if (!res.ok) break;

        const data: unknown = await res.json();
        if (!Array.isArray(data)) break;
        for (const item of data) {
          const page = toCanvasPage(item);
          if (page) pages.push(page);
        }

        const next = parseLinkNext(res.headers.get('link'));
        pagesFollowed += 1;
        // Anti-runaway cap, consistent with `importCourse`.
        if (next && pagesFollowed >= MAX_PAGES) break;
        url = next;
      }
      return pages;
    },
  };
}

/**
 * Map one raw Canvas page object to the frozen `CanvasPage` descriptor. Returns
 * `null` for a non-object / id-less entry so it is skipped rather than surfaced
 * as a junk row. `page_id` is the identity (stringified); the `url` slug is a
 * fallback id so a list entry is never dropped purely for lacking `page_id`.
 */
function toCanvasPage(item: unknown): CanvasPage | null {
  if (typeof item !== 'object' || item === null) return null;
  const raw = item as Record<string, unknown>;

  const id = scalarId(raw.page_id) ?? scalarId(raw.url);
  if (id === undefined) return null;

  const page: CanvasPage = {
    id,
    title: typeof raw.title === 'string' ? raw.title : '',
  };
  const url = firstString(raw.html_url, raw.url);
  if (url !== undefined) page.url = url;
  if (typeof raw.updated_at === 'string') page.updatedAt = raw.updated_at;
  return page;
}

/** A non-empty string or finite number coerced to a string id, else undefined. */
function scalarId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The first argument that is a string, else undefined. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string') return value;
  return undefined;
}

/** Default-wired page readers (global `fetch`). The runtime (T4) consumes these. */
const defaultReader = createPageReader();

/** GET a single page's body HTML. Read-only. Returns '' if the page has no body. */
export const fetchPageBody: PageReader['fetchPageBody'] = (config, courseId, pageId) =>
  defaultReader.fetchPageBody(config, courseId, pageId);

/** GET all pages in a course (paginated), mapped to CanvasPage. Read-only. */
export const listPages: PageReader['listPages'] = (config, courseId) =>
  defaultReader.listPages(config, courseId);

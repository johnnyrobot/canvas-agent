/**
 * Read-only HTTP transport for the Canvas importer (PRD §17).
 *
 * Every request the importer makes goes through `createCanvasGet`, the single
 * choke point that:
 *   - hard-codes `method: 'GET'` and THROWS if asked for any other method, so a
 *     write can never reach Canvas (the read-only guarantee), and
 *   - attaches `Authorization: Bearer <token>` + `Accept: application/json`.
 *
 * Zero runtime dependencies: it uses the global `fetch`, injected for tests.
 */

/** The slice of the global `fetch` we depend on (injected as a fake in tests). */
export type FetchLike = typeof globalThis.fetch;

export interface CanvasGetOptions {
  /** Canvas access token, sent as `Bearer <token>` (never logged or persisted). */
  token: string;
  /** Transport. Defaults to the global `fetch`; tests pass a recording fake. */
  fetch?: FetchLike;
}

/**
 * A bound GET function. The optional `method` exists ONLY so the read-only
 * guard can reject a non-GET caller — there is no code path that performs a
 * mutating request.
 */
export type CanvasGet = (url: string, method?: string) => Promise<Response>;

/** Build the read-only GET client. */
export function createCanvasGet(opts: CanvasGetOptions): CanvasGet {
  const doFetch: FetchLike = opts.fetch ?? globalThis.fetch;
  const { token } = opts;

  return async function get(url: string, method = 'GET'): Promise<Response> {
    if (method !== 'GET') {
      throw new Error(
        `read-only Canvas importer refuses non-GET method "${method}" (PRD §17: the source course is never mutated)`,
      );
    }
    return doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
  };
}

/**
 * Parse an RFC-5988 `Link` header and return the `rel="next"` URL, or `null` if
 * there is no next page. Canvas list endpoints paginate via this header.
 *
 * Format: `<https://…?page=2>; rel="next", <https://…?page=9>; rel="last"`.
 * Tolerant of surrounding whitespace and unquoted `rel` values.
 */
export function parseLinkNext(linkHeader: string | null | undefined): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const segments = part.split(';');
    const urlSegment = segments[0]?.trim();
    if (!urlSegment) continue;
    const matched = urlSegment.match(/^<(.+)>$/);
    if (!matched) continue;
    const isNext = segments.slice(1).some((s) => /\brel\s*=\s*"?\s*next\s*"?/i.test(s));
    if (isNext) return matched[1] ?? null;
  }
  return null;
}

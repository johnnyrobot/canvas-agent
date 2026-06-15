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
  /**
   * Per-request timeout (ms). A hung or throttling Canvas instance must not hang
   * the import indefinitely, so each GET aborts after this budget. Default 30s —
   * shorter than the LLM client's, since these are small JSON list calls.
   */
  timeoutMs?: number;
  /**
   * The Canvas instance this client is bound to. When set, EVERY request URL must
   * be same-origin with it; a cross-origin URL is refused BEFORE the Bearer token
   * is attached or any request is made. This is the token-exfiltration backstop:
   * a hostile `Link: rel="next"` (or any other Canvas-supplied URL) pointing at a
   * different host can never carry the token off-origin. All real callers pass
   * `config.baseUrl`; tests may omit it.
   */
  baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Origin of a URL, or `null` when it does not parse (so it can never falsely match). */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True only when both URLs parse AND share an origin (scheme + host + port). */
export function sameOrigin(a: string, b: string): boolean {
  const oa = originOf(a);
  return oa !== null && oa === originOf(b);
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
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedOrigin = opts.baseUrl;

  return async function get(url: string, method = 'GET'): Promise<Response> {
    if (method !== 'GET') {
      throw new Error(
        `read-only Canvas importer refuses non-GET method "${method}" (PRD §17: the source course is never mutated)`,
      );
    }
    // Token-exfiltration backstop: never attach the Bearer token to — or even
    // dispatch — a request whose origin differs from the bound Canvas instance.
    if (allowedOrigin !== undefined && !sameOrigin(url, allowedOrigin)) {
      throw new Error(
        `read-only Canvas importer refuses a cross-origin request to ${originOf(url) ?? 'an unparseable URL'} ` +
          `(this client is bound to ${originOf(allowedOrigin) ?? allowedOrigin}); the Bearer token is never sent off-origin`,
      );
    }
    return doFetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      // Each GET gets its own timeout budget so one stuck page can't wedge the crawl.
      signal: AbortSignal.timeout(timeoutMs),
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

/**
 * Test-only fake Canvas transport. Zero runtime use — it exists so the canvas
 * track's `node:test` suites stay fully offline: it implements the same shape as
 * the global `fetch` (`FetchLike`), records every request (method, url, auth +
 * accept headers) for read-only assertions, and returns canned JSON `Response`s
 * with optional RFC-5988 `Link` headers for pagination tests.
 *
 * It is NOT part of the shipped importer (which uses plain `fetch` only).
 */
import type { FetchLike } from './http.js';

/** One recorded outbound request, captured by the fake for assertions. */
export interface RecordedCall {
  method: string;
  url: string;
  authorization: string | null;
  accept: string | null;
  /** True when the request carried an AbortSignal (e.g. a per-request timeout). */
  signal: boolean;
}

/** What a route handler returns for a given request. */
export interface CannedResponse {
  /** HTTP status (default 200). */
  status?: number;
  /** JSON body to serialize (default `null`). */
  body?: unknown;
  /** Raw `Link` header value, e.g. `<…?page=2>; rel="next"`. */
  link?: string;
}

/** Maps a parsed request URL to a canned response. */
export type RouteHandler = (url: URL) => CannedResponse;

export interface FakeCanvas {
  fetch: FetchLike;
  calls: RecordedCall[];
}

/** Build a fake `fetch` over a routing function, plus the recorded call log. */
export function fakeCanvas(route: RouteHandler): FakeCanvas {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = input instanceof URL ? input.href : String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url,
      authorization: headers.get('authorization'),
      accept: headers.get('accept'),
      signal: init?.signal instanceof AbortSignal,
    });
    const canned = route(new URL(url));
    const status = canned.status ?? 200;
    const responseHeaders = new Headers({ 'content-type': 'application/json' });
    if (canned.link) responseHeaders.set('link', canned.link);
    const payload = status === 204 ? null : JSON.stringify(canned.body ?? null);
    return new Response(payload, { status, headers: responseHeaders });
  };
  return { fetch: fetchImpl, calls };
}

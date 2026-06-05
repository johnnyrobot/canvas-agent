# canvas — read-only Canvas course import (PRD §17)

A single, dependency-free module that crawls a Canvas course over the REST API
and returns a summary. It implements the frozen `CanvasImporter` port from
`src/contracts/index.ts` and is consumed by the app's import flow.

| Export | Kind | Contract type |
| --- | --- | --- |
| `importCourse` | default importer (global `fetch` + system clock) | `CanvasImporter` |
| `createImporter({ fetch?, now? })` | DI factory | → `CanvasImporter` |
| `fetchPageBody(config, courseId, pageId)` | read-only page-body read (global `fetch`) | → `Promise<string>` |
| `listPages(config, courseId)` | read-only page list (global `fetch`) | → `Promise<CanvasPage[]>` |
| `createPageReader({ fetch? })` | DI factory for the page readers | → `PageReader` |
| `createCanvasGet({ token, fetch? })` | read-only transport | `CanvasGet` |
| `parseLinkNext(header)` | RFC-5988 `Link` parser | `string \| null` |

All are re-exported from `src/canvas/index.ts` — the single public surface.

## Read-only page access (Remediate import source, PRD §17)

So Remediate mode (runtime track T4) can import existing Canvas content to repair,
two **GET-only** reads sit on the same transport as the importer:

- `fetchPageBody(config, courseId, pageId)` → `GET /api/v1/courses/:id/pages/:pageId`,
  returning the response's `body` string, or `''` when the page has no body. A
  non-2xx page (e.g. 404) **throws** a clear error.
- `listPages(config, courseId)` → `GET /api/v1/courses/:id/pages` with the same
  `per_page=100` + `Link: rel="next"` pagination and `MAX_PAGES` cap as the
  importer, mapping each Canvas page to `CanvasPage { id, title, url?, updatedAt? }`
  (`page_id`→`id` stringified, `html_url`/`url`→`url`, `updated_at`→`updatedAt`).
  A forbidden/failed list **degrades gracefully** (returns whatever was collected,
  `[]` on a first-page error) rather than throwing — consistent with the importer.

Returned HTML is **untrusted**: the runtime gates it before render. This module
neither sanitizes nor trusts it. `createPageReader({ fetch })` is the DI factory
the tests use to inject a recording fake; the top-level functions are wired to the
global `fetch`.

## `importCourse(config, courseId)` → `CanvasImportResult`

Given `config = { baseUrl, token }` and a `courseId`, it issues **HTTP GET only**
requests against the Canvas REST API and aggregates:

- `GET /api/v1/courses/:id` → course `name`
- `GET /api/v1/courses/:id/pages` → `pages` count
- `GET /api/v1/courses/:id/assignments` → `assignments` count
- `GET /api/v1/courses/:id/files` → `files` count

returning `{ courseId, name, importedAt, pages, assignments, files, warnings }`.

Each request sends `Authorization: Bearer <token>` and `Accept: application/json`.
In production the token comes from the Keychain (`SecretStore`, storage track)
and is passed in via `config.token` — this module never reads the Keychain.

## READ-ONLY guarantee (non-negotiable, PRD §17)

The importer **must never mutate the source course.** Every request is built by
`createCanvasGet`, the single choke point that hard-codes `method: 'GET'` and
**throws** if ever asked for a non-GET method. There is no code path that issues
POST/PUT/PATCH/DELETE. The test suite asserts that **every** recorded request
used `GET` (see `importer.test.ts` and `http.test.ts`).

## Behaviour details

- **Partial import.** A failed/forbidden sub-resource (e.g. `/files` → 403) does
  not fail the import: its count becomes `0` and a `warnings` entry records the
  HTTP status. The other resources are still imported.
- **The course is the identity.** If `GET /courses/:id` itself is non-2xx, the
  import throws — there is no meaningful summary without the course.
- **Pagination.** List endpoints request `per_page=100` and follow the
  `Link: …; rel="next"` header, accumulating counts across pages. A defensive
  `MAX_PAGES` cap (1000) guards against runaway loops; if the cap is hit while
  more pages remain, a truncation warning is pushed so the count is **never
  silently short**.
- **`baseUrl`** is normalized (a trailing slash is trimmed) before paths are
  appended; `courseId` is URL-encoded.

## Dependency injection / testability

`createImporter({ fetch, now })`:

- `fetch` — defaults to `globalThis.fetch`; tests inject a fake that records
  every call (method + url + headers) and returns canned JSON `Response`s with
  optional `Link` headers (`fake-canvas.ts`). **No real network in tests.**
- `now` — defaults to `() => new Date().toISOString()` for `importedAt`. The
  default is invoked **only on the real import path**, so no wall-clock call
  happens at module load or in tests (which inject a fixed clock).

## Tests

`http.test.ts`, `importer.test.ts`, `index.test.ts` — run via `npm test`
(`node:test` + tsx). Strict TDD; zero runtime dependencies; fully offline.
Covered: happy-path counts + name, the all-GET read-only assertion, Bearer-auth
headers, a 403 sub-resource → warning + partial import, Link-header pagination,
an unreadable course rejecting, and `baseUrl` normalization.

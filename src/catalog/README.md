# catalog — LACCD eLumen course-catalog enrichment (OPTIONAL)

A single, dependency-free module that shells out to the locally installed
`laccd-courses-pp-cli` binary and returns real course SLOs, objectives, units,
and descriptions from the public LACCD eLumen catalog — replacing placeholder
text with the actual approved course outline. It is consumed by the app's
catalog IPC handlers (`src/app/ipc.ts`).

| Export | Kind | Contract type |
| --- | --- | --- |
| `createCatalogClient({ command?, execFile?, timeoutMs? })` | DI factory | → `CatalogClient` |
| `CatalogError` | typed error class (`.kind`) | — |

All are re-exported from the module; there is no default-wired singleton (unlike
`src/canvas`) because the CLI's install location varies by machine — callers
resolve/inject a `command` (or rely on the `laccd-courses-pp-cli` PATH default).

## OPTIONAL enrichment — this is not a required dependency

Everything in this module degrades honestly when the CLI isn't installed:

- `available()` never throws. It resolves `false` when the binary can't be
  resolved or run, so callers (the IPC layer, the UI) can show/hide the
  enrichment feature instead of surfacing a confusing error.
- There is no bundled binary and no install step here — `laccd-courses-pp-cli`
  is an independent tool the user installs separately. If it's absent, the app
  works exactly as it did before this module existed (placeholder SLOs).

## This makes real, user-initiated network calls — same category as Canvas import

`laccd-courses-pp-cli` reads a **local synced mirror** of the LACCD catalog
when one exists, but falls back to the **public eLumen API live** when the
mirror is empty or the request isn't covered locally. The CLI reports which
per call in its `meta.source` field, which this module surfaces on every
`CatalogCourse` as `source: 'live' | 'mirror'` — so a live fetch to a
third-party public API is never silently indistinguishable from a cached
local answer.

This is the same category of network access as the existing, opt-in Canvas
import (`src/canvas`): triggered only by a user action (searching/opening a
course), read-only, and never a background/automatic call the user didn't ask
for.

## `createCatalogClient(opts?)` → `CatalogClient`

```ts
interface CatalogClient {
  available(): Promise<boolean>;
  searchCourses(query: string): Promise<CatalogCourseSummary[]>;
  getCourse(id: number): Promise<CatalogCourse>;
}
```

- `available()` — resolvable binary AND a lightweight `agent-context` probe
  exits 0. Never throws.
- `searchCourses(query)` — runs `laccd-courses-pp-cli courses search --query
  <q> --agent`, parses the JSON envelope (`{ meta, results: [...] }`), and maps
  each row to a `CatalogCourseSummary` (`id`, `code`, `title`, `college?`). The
  numeric `id` is parsed from `_links.self.href` (e.g.
  `"/public/courses/38409"` → `38409`); a row with no parseable id is skipped
  rather than surfaced as junk.
- `getCourse(id)` — runs `laccd-courses-pp-cli courses get <id> --agent` and
  parses the single result's nested `fullCourseInfo` field, which the CLI
  returns as a **JSON-encoded string** (not a nested object): SLOs are
  `fullCourseInfo.outcomes` filtered to `outcomeLevel === "CSLO"`, objectives
  come from `fullCourseInfo.objectives` sorted by their authored `sequence`,
  units come from the default (or first) `creditsAndHours` entry's `credit`,
  and `description` is `fullCourseInfo.courseDescription`. A missing
  `fullCourseInfo` degrades to a shell record (id/code/title only) rather than
  an error; a **malformed** `fullCourseInfo` string is a typed
  `CatalogError('parse', …)`, never an uncaught throw.

## READ-ONLY guarantee

This adapter only ever invokes `agent-context`, `courses search`, and
`courses get` — the CLI's own read-only, `mcp:read-only: true`-annotated
commands. There is no code path that runs `sync`, `import`, `config set`, or
any other CLI subcommand that could write local state or upstream data.

## Process safety

Every invocation goes through `execFile` with an **argument array**, never a
shell string — user-typed search text (or anything else) is passed as `argv`
and can never be interpreted as shell syntax, no matter what characters it
contains. Each call has its own timeout budget (default 15s) so a
hung/throttled CLI can't hang the caller indefinitely.

## Typed errors (`CatalogError`)

Every failure — a non-zero exit, a spawn failure, a timeout, or malformed
JSON — becomes a `CatalogError` with a `.kind`:

- `notFound` — the course/query id doesn't exist in the catalog.
- `rateLimited` — the public eLumen API throttled this request.
- `unavailable` — the CLI binary couldn't be resolved/run at all.
- `parse` — the outer JSON envelope or the nested `fullCourseInfo` string
  couldn't be parsed.
- `timeout` — the invocation exceeded its time budget and was killed.
- `cliError` — any other non-zero exit (a genuine upstream API error, a CLI
  usage error, etc.).

The CLI's documented exit-code contract (`0` ok, `2` usage, `3` not found,
`5` API error, `7` rate limited, `10` config) is checked first, but the
installed build was observed to exit `1` for nearly every failure in
practice — so the primary signal is sniffing the HTTP status the CLI embeds
in its own stderr message (e.g. `"returned HTTP 404: ..."`). Both paths are
covered so a future CLI build that does emit the documented codes still maps
correctly.

## Dependency injection / testability

`createCatalogClient({ command, execFile, timeoutMs })`:

- `execFile` — defaults to a promisified `child_process.execFile`; tests
  inject a fake that records every call (file + args) and returns/rejects
  canned results shaped exactly like Node's real `execFile` error (`code`,
  `killed`, `stdout`, `stderr`). **No real process is ever spawned in tests.**
- `command` — defaults to `'laccd-courses-pp-cli'` (resolved via `PATH`);
  callers with a known absolute install path can pass it directly.
- `timeoutMs` — default 15000.

## Tests

`client.test.ts` — run via `npm test` (`node:test` + tsx). Strict TDD; zero
runtime dependencies beyond `node:child_process`; fully offline against
fixtures in `fixtures/` (`search-response.json`, `get-response.json` — real,
trimmed CLI output captured live). Covered: happy-path search + get with real
SLO/objective/units extraction, id parsing from `_links.self.href`, a skipped
unparseable row, a malformed `fullCourseInfo` (typed parse error, not a
crash), a missing `fullCourseInfo` (graceful shell record), the outer-JSON
parse-error path, HTTP-404/429/5xx → typed-error mapping, the documented
exit-code fallback (3/7/10), a timed-out (killed) invocation, an
ENOENT/missing-binary invocation, and `available()`'s true/false paths.

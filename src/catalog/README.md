# catalog — LACCD eLumen course-catalog enrichment (BUNDLED)

A single, dependency-free module that shells out to the `laccd-courses-pp-cli`
binary and returns real course SLOs, objectives, units, and descriptions from
the public LACCD eLumen catalog — replacing placeholder text with the actual
approved course outline. It is consumed by the app's catalog IPC handlers
(`src/app/ipc.ts`).

| Export | Kind | Contract type |
| --- | --- | --- |
| `createCatalogClient({ command?, home?, execFile?, timeoutMs? })` | DI factory | → `CatalogClient` |
| `CatalogError` | typed error class (`.kind`) | — |

All are re-exported from the module; there is no default-wired singleton (unlike
`src/canvas`) because the binary's location differs between dev and a packaged
app — callers resolve/inject a `command` (or rely on the PATH default).

## Bundled in the packaged app; optional in dev

**Packaged:** the arm64 binary and a ~900 MB course seed ship inside the `.app`
(`sidecars/laccd-courses-pp-cli/`). `src/app/main.ts` resolves the binary via
`resolveSidecarCommand`, copies the seed once into a writable home
(`ensureCatalogHome` → `<dataDir>/catalog-home/data/data.db`, atomic temp+rename),
and injects a client bound to that home. So **local search works fully offline,
out of the box** — that is what the 900 MB buys.

**Dev:** nothing is bundled. The module falls back to a `laccd-courses-pp-cli`
PATH lookup, and if it isn't installed the app behaves exactly as it did before
this module existed (placeholder SLOs).

Either way it degrades honestly:

- `available()` never throws. It resolves `false` when the binary can't be
  resolved or run, so callers (the IPC layer, the UI) can show/hide the
  enrichment feature instead of surfacing a confusing error.
- The packaged wiring is **fail-safe**: any resolution/copy failure logs a
  warning and yields `undefined`, degrading only the catalog panel rather than
  downing the whole app. The trade-off is that a bundling mistake degrades
  *silently* — which is why `e2e/packaged-smoke.test.ts` asserts
  `catalogAvailable() === true` against the real `.app`.

## Why local search + live detail (measured, not assumed)

- **Search is LOCAL** (`--data-source local`). Live search measured **~17s** even
  tenant-scoped — unusable interactively. Local FTS over the seed is instant.
- **Detail is LIVE** (`--data-source auto`, live with local fallback). A live GET
  measured **2.4s**, and SLOs must be current — a stale mirror would hand an
  instructor outdated outcomes. `CatalogCourse.source` reports which path served
  it, and the packaged smoke fails if a GET silently degrades to `'mirror'`.

Note the CLI has two different search surfaces: the **top-level `search`**
command filters properly, while `courses search --query` does **not** filter
under `--data-source local` (it dumps all ~9.7k rows). This module uses the
top-level one.

## Seed provenance

The bundled seed is built by `scripts/build-catalog-seed.mjs` (see
`resources/STAGING.md`): full mirror sync → `scripts/trim-catalog-seed.py`
(empties the redundant `resources.data` blobs for courses; keeps `courses.data`,
which local search reads for display) → self-verify through the real CLI.

The build **gates on `coverage --data-source live` reporting zero missing
courses district-wide**. This matters: the district API has been observed to cut
off mid-mirror (http2 GOAWAY), and the CLI's default exit policy downgrades that
to a warning with exit 0. A truncated mirror still searches perfectly well while
silently missing whole colleges, so "does search return rows?" cannot catch it —
only the coverage gate can.

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

Every invocation is prefixed with `--home <dir>` when the factory was given a
`home` (always so in the packaged app) and suffixed with `--agent --data-source
<local|auto>`.

- `available()` — resolvable binary AND a lightweight `agent-context` probe
  exits 0. Never throws.
- `searchCourses(query)` — runs `search <q> --type courses --limit 25
  --agent --data-source local`, parses the JSON envelope
  (`{ meta, results: [...] }`), and maps each row to a `CatalogCourseSummary`
  (`id`, `code`, `title`, `college?`). The numeric `id` is parsed from
  `_links.self.href` (e.g. `"/public/courses/38409"` → `38409`); a row with no
  parseable id is skipped rather than surfaced as junk.
- `getCourse(id)` — runs `courses get <id> --agent --data-source auto` and
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

This adapter only ever invokes `agent-context`, `search`, and `courses get` —
the CLI's own read-only, `mcp:read-only: true`-annotated commands. There is no
code path that runs `sync`, `import`, `config set`, or any other CLI subcommand
that could write local state or upstream data.

The seed build **does** run `sync`, but that is a release-time build script
(`scripts/build-catalog-seed.mjs`) run by a human on the build machine — never
by the app at runtime. The shipped app only ever reads.

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

`createCatalogClient({ command, home, execFile, timeoutMs })`:

- `execFile` — defaults to a promisified `child_process.execFile`; tests
  inject a fake that records every call (file + args) and returns/rejects
  canned results shaped exactly like Node's real `execFile` error (`code`,
  `killed`, `stdout`, `stderr`). **No real process is ever spawned in tests.**
- `command` — defaults to `'laccd-courses-pp-cli'` (resolved via `PATH`);
  callers with a known absolute install path can pass it directly. The packaged
  app passes the bundled sidecar path.
- `home` — `--home` root, prefixed on **every** call when set. The packaged app
  passes `<dataDir>/catalog-home`. Required there because the CLI opens its DB
  **read-write**, so it cannot run against the read-only app bundle — hence the
  first-run copy. Unset in dev, where the CLI uses its own default home.
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

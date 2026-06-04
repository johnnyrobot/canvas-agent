# `src/storage` — SQLite + Keychain + local file layout

Foundation for the single-user, on-device macOS desktop app (PRD v1.6 §3/§16,
HANDOFF §3.3). **Zero runtime dependencies** — Node built-ins only
(`node:sqlite`, `node:child_process`). Other tracks (knowledge, canvas) depend
only on the ports in [`src/contracts`](../contracts/index.ts) and receive these
implementations by injection — never by importing this module's internals.

## Public surface (`index.ts`)

| Export | Port | What it does |
| --- | --- | --- |
| `openDatabase(path)` | `OpenDatabase` → `Database` | Opens a `node:sqlite` DB. `':memory:'` for tests or a file path. Enables `WAL` + `foreign_keys=ON`. All values are passed as **bound parameters** (never string-concatenated). Rows are returned as plain objects. |
| `migrate(db)` | `(db: Database) => Promise<void>` | Applies the idempotent **core** schema and stamps `meta.schema_version`. Safe to call on every launch. |
| `createKeychainSecretStore({ service?, runner? })` | `SecretStore` | macOS Keychain-backed secret store via the `security` CLI. |
| `createInMemorySecretStore()` | `SecretStore` | Map-backed store for tests and other tracks. |
| `resolveAppPaths(override?)` | `AppPaths` | Pure resolver for the local file layout. See `ensureAppDirs` to create dirs. |

Also exported: `ensureAppDirs(paths)`, `SCHEMA_VERSION`, and the
`CommandRunner` / `CommandResult` / `KeychainOptions` types.

## Schema (`schema.ts`)

Idempotent core tables: `projects`, `sessions` (→ projects, `ON DELETE
CASCADE`), `turns` (→ sessions, `ON DELETE CASCADE`), `canvas_imports` (keyed by
`course_id`), and `meta` (key/value, holds `schema_version`). **`kb_*` and FTS5
tables are intentionally NOT created here — the knowledge track owns those.**

## File layout (`paths.ts`)

Defaults under `~/Library/Application Support/CanvasAgent`:
`canvas-agent.sqlite`, `uploads/`, `exports/`. `resolveAppPaths` is pure (no
filesystem access); overriding `dataDir` re-bases the derived paths, and an
explicit field override wins. Tests point it at a tmp dir.

## Security

- **Parameterized SQL only** — values are bound, never interpolated into SQL.
- The Canvas token lives in the **Keychain**, never in the DB or on disk.
- The `security` CLI is invoked via `execFile('security', [...args])` with an
  **argument array — never a shell string**, so secret values containing shell
  metacharacters cannot be interpreted. The command runner is injectable, so
  tests run fully offline without touching the real Keychain.

> `node:sqlite` is experimental and prints a one-line warning on first use.
> That is expected and acceptable — it is a Node built-in, so still zero deps.

## Tests

`node:test` + `tsx`, strict TDD, fully offline (`:memory:` DBs + a stubbed
command runner for the Keychain). Run with `npm test`; typecheck with
`npm run typecheck`.

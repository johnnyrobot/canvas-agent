# `src/sidecar` — Shared local-sidecar process lifecycle

Attach-if-running / spawn-if-not / stop-with-TERM-then-KILL for the app's local
child processes, implemented **once** (ADR-0004). Both sidecars — `ollama serve`
(`src/llm`) and `docling-serve` (`src/ingest`) — run the same algorithm; this is
that algorithm.

It was previously written twice. That duplication is why the respawn supervisor
built for Ollama never reached Docling: a mid-session docling-serve crash stayed
dead until the app restarted, because `DoclingProcess` simply had no
`ensureAlive`. Sharing one lifecycle closed that by construction.

## Layout

| File | Responsibility |
|---|---|
| `lifecycle.ts` | `SidecarLifecycle` — attach/spawn/readiness/respawn/stop |
| `index.ts` | Public surface for `src/llm` and `src/ingest` |
| `lifecycle.test.ts` | Contract tests for the shared behaviour (no real process) |

## This is a LEAF module

It imports **nothing** from `src/runtime` (the composition root, which must stay
a consumer), and nothing from `src/llm` or `src/ingest`. Its only imports are
`node:child_process` and `node:timers/promises`. The dependency arrow points one
way: `llm` → `sidecar` ← `ingest`.

## The adapter surface

A sidecar supplies **two** things by extending `SidecarLifecycle`:

| Member | Supplies |
|---|---|
| `isHealthy()` | Is a server listening? |
| `spawnSpec()` | Command, args, env — re-read on every (re)spawn |

`spawnSpec()` is called at spawn time rather than construction time so that
config-derived environment (Docling's offline artifacts path) cannot go stale
across a respawn.

Deliberately **not** part of the adapter surface:

- **`warmLoad`** (Ollama only) — preloading a model is a model concern.
- **`modelsPresent`** (Docling only) — first-run provisioning, not lifecycle.

Both stay on their own adapter. Folding them in would grow this surface with
every sidecar-specific need, which is the shape the ADR was avoiding.

## What the lifecycle guarantees

- **Attach, don't kill.** A sidecar already listening (started by the user or
  another process) is attached to, never owned, and never signalled by `stop()`.
- **Never manage what we were told not to.** With `manageProcess` off, nothing
  is ever spawned or respawned; the call fails naturally instead.
- **Start once.** `ensureRunning()` memoizes its in-flight promise, so concurrent
  and repeat callers cause one spawn. A *failed* start clears the memo so a later
  call retries; `stop()` clears it so the sidecar can be started again.
- **Crash recovery.** `ensureAlive()` respawns a process that has died
  mid-session, bounded by a sliding-window `RespawnPolicy` (default 3 per 60s) so
  a crash-looping sidecar reports a clear error instead of restarting forever.
  Call it before each request, not once at startup.
- **No orphans.** A hung-but-unreachable process is SIGKILLed before its
  replacement spawns, and both the `error` and `exit` handlers are bound to the
  specific child, so a late event from a replaced process cannot null out the
  live one.

## Gotchas

- `ensureRunning()` memoizes **success**. After a mid-session crash it is a
  no-op, so a request path needs `ensureAlive()` as well — `ensureRunning()`
  alone will happily let the request hit a dead endpoint.
- Readiness timeouts differ per sidecar and are passed in, not defaulted here:
  Ollama waits 30s, docling-serve 60s (Python plus model boot).

---
status: accepted
---

# The composition root owns process lifetimes

The app spawns two sidecar processes and never stops them; both survive quit as
orphans (#13). We will move sidecar construction up one level, out of
`createAppApi` and into a `createRuntime` composition root that returns
`{ api, dispose }`, and wire that `dispose` to Electron's `before-quit`.

## Why there is no shutdown path today

The teardown logic already exists and is correct. `SidecarLifecycle.stop()`
(`src/sidecar/lifecycle.ts:194`) does TERM-then-KILL with a grace period and
honors attach-don't-kill — it never signals a process it did not spawn. Both
sidecars delegate to it. Only the trigger is missing.

It is missing because `createAppApi` (`src/runtime/app-api.ts:412-417`)
*constructs* the sidecars it uses and returns `AppApi`, which has no lifecycle
members. The two processes are owned by a closure nothing outside can reach. The
lazily-opened SQLite handle (`app-api.ts:445-455`) has the same problem.

## Considered options

**`dispose` on `AppApi`** — rejected on the contract's own terms. The growth law
would force a `CHANNELS` entry and a `bridge.ts` handler, which is to say it
would make **app shutdown a renderer capability**. The renderer must not be able
to stop the app's sidecars.

**A module-level dispose registry in `src/runtime`** — the smallest diff, with no
signature changes anywhere. Rejected for test isolation: it is hidden global
mutable state shared by every test that imports `app-api`, in a suite that runs
in-process.

**`main.ts` constructs and owns the sidecars** — maximally explicit, and the
honest expression of "whoever constructs, disposes". Rejected because it drags
sidecar wiring into the one file that is deliberately thin and *cannot* be
unit-tested, since it imports Electron. It would put new logic in the only place
with no coverage.

## Shape

`createAppApi`'s signature does **not** change; its `?? createOllamaSidecar(...)`
defaults remain for callers that inject nothing (`e2e/live.test.ts`,
`scripts/probe-runtime.mjs`). `createRuntime` simply constructs the owned parts
first and passes them down through the injection seams that already exist:

```ts
const api = createAppApi({ ...opts, chatRunner: llm, llm, ingest, database, activity });
```

`chatRunner` and `llm` are the same object — that is already the production
wiring — so `dispose` must stop it once, not twice.

`buildApi` widens from `AppApi` to that handle. Its C3 fallback policy is
unchanged: a runtime that fails to construct still yields the honest
*unavailable* API, never the demo stub, now paired with a no-op `dispose` so a
degraded app quits identically to a healthy one.

Quit sequencing lives in `src/app/shutdown.ts`, which takes a narrow `QuitHost`
port rather than Electron's `app`, so the deadline and re-entrancy behaviour are
unit-tested. `main.ts` gains only the wiring.

## The quit budget

`before-quit` preventDefaults, drains an in-flight turn for up to 3s, then runs
`stop()`/`close()` under the lifecycle's existing 5s TERM-then-KILL — hard-capped
at 8s, after which `app.exit(0)` fires regardless. **A leaked sidecar is a better
outcome than an app that will not quit.**

Draining matters because "turn in flight" is exactly the window in which a
per-turn Chromium exists (ADR-0005). Letting the turn settle is what allows that
browser to be disposed by its own `finally` instead of orphaned alongside the
sidecars. The bracket is `withTurnAuditor` (`app-api.ts:486`) — already the
single path `runTurn` takes, for both the remediate and standard branches. When
the drain itself times out, this protection lapses: `dispose()` proceeds straight
into `stop()`/`close()` and `app.exit(0)` follows, while the turn that never
settled is still running. Its per-turn Chromium never reaches that `finally` and
is orphaned exactly like the sidecars would have been without this ADR, and its
session write is lost outright, since the database is already latched closed by
the time it would try to persist.

`SIGINT`/`SIGTERM` route to `app.quit()` so the same handler runs. Ctrl-C on
`npm run app` otherwise kills Electron without firing `before-quit`, leaking in
the dev inner loop exactly as #13 describes in the shipped app.

## Consequences

ADR-0005 declined to keep a process-wide Chromium warm because doing so "would
need the app's first-ever teardown built from scratch". That blocker is now
removed — but removal is not a reason to reverse the decision. The measured win
was five browser launches collapsing to one *inside* a single turn, which
per-turn lifetime already captures in full; a warm browser *between* turns was
never measured. Reopening that choice needs its own measurement, not this ADR.

`stop()` is a no-op on a process we attached to rather than spawned, so a user's
own pre-existing `ollama serve` survives quit. That is existing behaviour and
this change adds no path around it — but it is now load-bearing in a way it was
not before, and is covered by an explicit manual check.

No offline test proves a real daemon dies. The unit tests cover sequencing,
deadlines, and idempotence against doubles; killing an actual process is verified
by hand against a built app.

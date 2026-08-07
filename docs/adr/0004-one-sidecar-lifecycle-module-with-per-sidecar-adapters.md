---
status: accepted
---

# One sidecar lifecycle module with per-sidecar adapters

Attach-if-running / spawn-if-not / stop-with-TERM-then-KILL is implemented twice —
`src/llm/process.ts` (221 lines) and `src/ingest/process.ts` (152 lines) — with the
same algorithm. That duplication is why the respawn supervisor built for Ollama in
`72dcef71` never reached Docling: `DoclingProcess` has no `ensureAlive`, so a
mid-session crash stays dead until the app restarts. We will put the lifecycle in
one module and have each sidecar supply only its health check and its spawn
arguments.

## Shape

The lifecycle lands in a new **`src/sidecar/` leaf module** — not `src/runtime/`,
which is the composition root and must stay a consumer. The adapter surface each
sidecar supplies is **health check + spawn spec only**. `modelsPresent()` stays
Docling-only; it is a first-run provisioning concern, not a lifecycle one.

The memoized in-flight start currently lives one layer *up*, in
`IngestSidecar.ensureStarted()`, while `OllamaSidecar.start()` re-runs
`ensureRunning` + `warmLoad` unguarded on every call. Moving the memoization into
the shared lifecycle moves it *down* a layer — from `sidecar.ts` into the process
lifecycle — which is how Ollama gains it. That makes this lane four files, not two.

## Consequences

The `Mutex.acquire` timeout ships **separately**. It is a concurrency defect, not a
lifecycle refactor, and folding it into this lane would blur a diff that is
otherwise a pure move. Filed as its own issue.

Docling's crash recovery, by contrast, ships **inside** this lane, as its final
commit. It fails the same "behaviour change, not a move" test as the mutex, but not
by the same mechanism: the mutex lives in `src/llm/mutex.ts`, untouched here,
whereas Docling's respawn is *emergent* — once both sidecars share one lifecycle,
preventing Docling from inheriting `ensureAlive` would take more code than letting
it. Keeping it as a separate final commit preserves the property that mattered:
the move itself stays reviewable as a pure move.

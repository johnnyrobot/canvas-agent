---
status: accepted
---

# Chromium is reused per turn, not process-wide

Every `audit()` launches and closes its own Chromium process — up to five per
remediate turn. We will hold one browser for the duration of a turn and dispose it
when the turn ends, rather than keeping a process-wide singleton warm behind an idle
timeout.

## Considered options

A hidden process-wide singleton with an idle timeout was the initial choice, and was
reversed on a fact. **The app has no shutdown path at all**: `src/app/main.ts:159` is
the only lifecycle hook, and it is `window-all-closed → app.quit()` guarded by
`process.platform !== 'darwin'` — which never fires on the only platform this app
ships to. There is no `before-quit`, no `will-quit`, and `createAppApi` returns no
dispose.

That inverts the cost model. A singleton would need the app's first-ever teardown
built from scratch to avoid leaking a Chromium process. Per-turn lifetime captures
the entire measured win — five launches to one, because all five happen *inside* one
turn — with no new infrastructure. The singleton's only remaining benefit is a warm
browser *between* turns, which is not what was measured.

## Shape

`ScanRunner` (`src/engine/render/types.ts:72`) **stays a single method**. Adding
`dispose()` to it would force every injected test fake and `createAuditor` to grow a
lifecycle they don't need. Instead `createPlaywrightRunner()` returns a
`DisposableScanRunner` — `ScanRunner & { dispose(): Promise<void> }` — and the
remediate path constructs one per turn, hands it to `createAuditor`, and disposes it
in a `finally`.

The eagerly-constructed module-level singleton at `playwright-runner.ts:314`
(`export const playwrightRunner: ScanRunner = createPlaywrightRunner()`) **must go**.
It is harmless only while `run()` owns nothing between calls; once a runner holds a
browser, a module-level instance nobody disposes is precisely the leak this ADR
declines to accept. Single-audit callers such as the build gate construct and
dispose one per call — behaviourally identical to today.

## Consequences

The absent shutdown path is a real defect on its own terms — it currently leaks the
app's Ollama and Docling child processes on quit — and is filed separately. It is
not a prerequisite for this change, and this change must not become the excuse to
build it.

`docs/PRD_Canvas_Course_Design_Accessibility_Assistant.md:312` and `:357` already
claim one browser context is reused across a job. That has never been true. The
claim becomes approximately true when this lands; the PRD wording should be
corrected to say *per turn* at that point.

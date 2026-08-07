---
status: accepted
---

# Accessibility checks receive the whole ScanResult

Adding a deterministic accessibility check today means editing seven files, because
the auditor (`src/engine/render/auditor.ts`) hardcodes one numbered pass per rule.
We will register checks in one place and let the auditor iterate them. Each check
receives the **whole `ScanResult`**, and fields added to `ScanResult` for a new
check are **optional**, so existing checks and every fake fixture keep compiling.

## Considered options

The alternative was a declared-data-requirements design: each check declares the
page data it needs, and the auditor collects only that. Rejected as machinery sized
for a rule count that doesn't exist — there are three deterministic checks. The
optional-field rule buys the same fixture stability for a fraction of the
apparatus.

## Consequences

A registry removes the auditor edit and the fixture churn, but it does **not**
remove the browser-side extraction script when a check needs page data nobody
collects yet. The win is roughly four of the seven files, not seven.

This work lands **after** ADR-0005's per-turn browser change. The two collide in
`src/engine/render/playwright-runner.ts` and `src/engine/render/types.ts`, and
ADR-0005 settles the `ScanRunner` lifecycle that a check registry would otherwise be
designed against while it was still moving.

The optional-field rule is applied **retroactively**: the existing
`ScanResult.images` (`src/engine/render/types.ts:64`) becomes optional as part of
this, rather than grandfathering it. It is read in one production path
(`alt-text.ts`) and two test fixtures, so the retrofit is cheap — and a rule with a
single permanent exception is one people stop believing.

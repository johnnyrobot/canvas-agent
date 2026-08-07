---
status: accepted
---

# The renderer's screen model owns state and transitions

`src/app/renderer/renderer.ts` is 2,192 lines across 14 screens and 57 state fields,
and it executes in no offline test — its decision logic is welded to DOM
construction. We will extract that logic behind a DOM-free seam, and the extracted
**screen model owns the state and the transitions**, rather than being pure
functions computing over a snapshot handed in.

The repo's existing extraction convention (`ui-theme.ts`, `catalog-view.ts`) is the
snapshot shape, and we deliberately rejected extending it here. That convention
captured the string helpers and left the branching behind; a pure-function seam
would again leave the state machine outside the seam — including the orphaned
module-scope `let reviewSelectedId` (`renderer.ts:1012`) that makes
`realRemediationView()` unimportable without the whole module. The state machine is
the part that isn't testable, so it has to be the part that moves.

## Consequences

Proven as a **vertical slice first**: the remediate-review screen only
(`realRemediationView` + `reviewSelectedId`). Whether the other 13 screens follow is
a separate decision, deferred until the slice exists and its shape can be judged.

During the slice the renderer has **two state homes** — the screen model for
remediate-review, the module for the other thirteen. That is accepted, with an
explicit exit condition: **if converting the second screen does not shrink the
duality, stop and reassess** rather than grinding through the remaining twelve.

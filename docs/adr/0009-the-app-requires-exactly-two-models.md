---
status: accepted
---

# The app requires exactly two models: text and vision

`LLMConfig` has five model roles — `text`, `vision`, `fast`, `deep`, `cheap` —
and every one of them currently resolves to the same tag, because four inherit
`MODEL_TEXT` (`src/llm/config.ts:43-49`). Giving `vision` its own default breaks
that coincidence, and every provisioning and health surface assumes exactly one
tag. We will define the **required set** as exactly `{text, vision}`: those two
are pulled at first run, those two gate readiness, and the other three are
tiering aliases the app never provisions.

## Why not "every distinct configured tag"

That is the obvious generalisation, and it is unbounded. An administrator who
sets `MODEL_DEEP=granite4.1:30b` — a real tag, 17 GB — would trigger a 17 GB
first-run download for a role **no production code path calls**. `fast`, `deep`
and `cheap` are referenced only in `src/llm/example.ts`, a demo file.

It also costs the first-run UI its most useful sentence. The user is about to
download roughly 8.6 GB; with a fixed required set the app can say so before they
commit. With "whatever config resolves to," it cannot state a number in advance.

The rejected middle option — gate readiness on the required set but *report* every
distinct configured tag — was dropped as unearned complexity: it forces the health
contract to distinguish "required and missing" from "merely configured and
missing," to describe roles nothing calls.

## Shape

`RuntimeHealth` gains `visionModel?: ModelHealth` beside the existing `model?`,
which keeps its current meaning of *the text model*. This follows the
`ingestModel?` precedent already in the contract (`src/contracts/index.ts:486`):
a second provisioned model is modelled as a sibling optional field, not as an
element of a list. With the required set fixed at two, a list buys nothing —
every reader would immediately index it by role. The change is additive, so it
does not trip the AppApi growth law (no `CHANNELS` entry, no `bridge.ts`
handler), but it does flow through all five `health()` implementers.

Severity follows `model`, not `ingestModel`. The renderer already runs two
policies: a missing text model marks the runtime **degraded**
(`renderer.ts:1510`), while missing Docling models only offer a download and leave
the runtime **ready** (`renderer.ts:1526-1528`), because office and web documents
still convert. Vision takes the degraded lane. The argument for the softer lane is
real — alt-text *detection* is deterministic (axe-core plus the PR #10
detections), so the scan-fix-rescan loop survives without any vision model — but
WCAG 1.1.1 is the flagship criterion this tool exists to serve, and "ready" should
not mean "ready except for the headline capability."

## Consequences

The bug this prevents is one **introduced by** giving `vision` its own tag, which
is why it is recorded before the change rather than after: first run pulls the
text model, `modelStatus()` reports available, the first-run UI completes and
dismisses, and the vision model is never downloaded. Alt-text then fails at
runtime, after install, on a machine the user believes is fully provisioned. A
partial install must never read as ready.

Three surfaces change together, and none is safe alone: `pullModel()`
(`src/llm/sidecar.ts:107-113`) pulls only `models.text`; `modelStatus()`
(`:85-97`) probes only `models.text`; and `modelHealth()`
(`src/runtime/app-api.ts:848-859`) takes one tag and returns one result. The
user-facing `installCommand` must list **both** tags — it is the manual-recovery
path, and a half-listed command leaves the user half-provisioned at exactly the
moment automation already failed.

`fast`, `deep` and `cheap` are now explicitly vestigial: configured, never
provisioned, never called outside an example file. This decision does not delete
them, but it records that nothing depends on them, so a later removal needs no
further investigation.

Aggregate the pull progress across both models. Restarting at 0% for the second
model, after the user was told to expect one download, reads as a failure and
restart rather than as progress.

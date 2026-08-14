---
status: accepted
---

# The vision model is pulled on first use, not at first run

First run downloads the required set — text and vision, ~8.6 GB (ADR-0009) — on
top of a 2.86 GB installer, so an instructor waits on ~11.5 GB before the app is
usable. We will keep the vision model in the required set but move **when** it is
fetched: first run pulls the text model alone, and the vision weights are
downloaded the first time the instructor asks for something that needs them.

## The number this is about

Measured on the staged tree, not estimated: Docling models 1.8 GB, catalog seed
954 MB, ollama sidecar 452 MB; `granite4.1:8b` 5.3 GB, `qwen3-vl:4b` 3.3 GB.

|                    | before usable | total    |
| ------------------ | ------------- | -------- |
| today              | 11.5 GB       | 11.5 GB  |
| deferred vision    | **8.2 GB**    | 11.5 GB  |

The total does not move. What moves is the wait before the app does anything, and
who chooses to spend the rest of it. The audience is community-college
instructors on institution-issued Macs; the sizing discipline that rejected
`gemma4:31b` for "excluding most target hardware outright" was applied to the
model set and never to what the instructor sits through.

Two other levers were considered and not taken here. Unbundling the Docling
models takes 1.7 GB off the installer but reverses ADR-0008 and needs the strict
gate that deliberately rejects such a build changed rather than bypassed; it
composes with this decision and remains available. Dropping the text default to
`granite4.1:3b` is the only lever that shrinks the *total*, by 3.2 GB — but that
model runs the tool-calling orchestrator, so a regression there breaks the core
loop rather than one feature, and it needs an evaluation first.

## A fifth state, derived rather than configured

`ModelStatusState` gains `deferred` beside `ready`, `missing`, `incapable` and
`disabled`. It means: this role is required, its tag is not installed, and that
is expected — the app will fetch it when the capability is first used.

It is **derived**, not a new configuration axis. `deferred` is exactly `missing`
for a role whose weights are provisioned on first use, so the role declares
*when* it is provisioned (`REQUIRED_ROLES[role].provisioning`) and the state
falls out of that plus what is installed. No second source of truth to keep in
step with the first, and a role added later cannot forget to answer the question,
because the record is a `Record<RequiredModelRole, …>` and the compiler walks it.

Once the tag is installed the role is graded exactly as before — `ready` or
`incapable`. A model deleted afterwards returns to `deferred`, which is correct:
the recovery is the same offer, and telling a user their install is broken when
one command re-fetches it is a worse description of the same fact.

## Why this is not the silent hole ADR-0009 argued against

ADR-0009 put vision in the **degraded** lane on purpose: alt-text detection is
deterministic and survives without a model, but WCAG 1.1.1 suggestion is the
flagship capability, and "ready must not mean ready except for that". ADR-0010
made the same argument again, in the narrower case of a switched-off capability,
and answered it by surfacing the state rather than dropping the role.

This decision does not weaken that. It draws a distinction the earlier two did
not need: between a capability that is **absent** and one that is **not yet
fetched**. The failure both ADRs were defending against is an instructor who
believes the app can do something it cannot. That failure needs the user to be
uninformed, and here they are told three times — at first run, which states that
alt-text suggestion downloads 3.3 GB the first time it is used; in the health
payload, where the role reports `deferred` rather than vanishing; and at the
moment of use, where the download is offered with its size before anything runs.

`deferred` therefore does not mark the runtime degraded — nothing is wrong — and
it is never offered by the first-run download affordance, which would defeat the
entire purpose. It stays distinct from `disabled`: an operator who set
`LLM_VISION_ENABLED=false` chose to have no vision at all and must never be
offered a download, while a deferred role is one click from working.

## The pull cannot happen inside the turn

Vision has two call sites and neither is a safe place to start a multi-gigabyte
download:

- `describe_image`, the alt-text suggestion tool, reached mid-turn through the
  orchestrator's tool loop;
- `userWithScreenshotContext` (`src/runtime/app-api.ts`), which describes every
  screenshot attached to a turn, before the model ever sees the request.

A turn is a streaming interaction the user is watching. Blocking one for the
minutes a 3.3 GB pull takes — with the progress surface outside the transcript
and no way to cancel without losing the turn — reads as a hang, which is the
first-run failure mode this repo already worked to avoid when it aggregated the
two-model bar rather than letting it reset.

So the offer is made **before the turn starts**, at the moment the instructor
attaches a screenshot or asks for alt text: state the size, download with the
existing aggregate progress, then run the turn. The in-turn path keeps a guard
anyway, because a pre-turn check can be bypassed by a path nobody thought about
and the failure it produces today is `Ollama /api/chat returned 400` — an error
that names nothing the user can act on. With the model absent, `describeImage`
must fail with the deferred diagnosis instead.

This is the weakest seam in the decision and is recorded rather than buried: the
pre-turn check and the set of turns that need vision are two lists that can drift
apart. The in-turn guard is what keeps the drift honest — an unanticipated path
gets a comprehensible error and an offer, not a 400.

## Consequences

`pullModel()` pulls the first-run set, so it stops fetching vision; a sibling
`pullVisionModel()` joins `AppApi` for the on-demand pull, following the
`pullIngestModel` precedent rather than growing an options bag on `pullModel`.
That is a new capability, so it takes the full AppApi growth-law walk: contract,
five implementers, `CHANNELS`, `bridge.ts`, and its own progress channel.

In the renderer, `deferred` must be excluded from `missingRequiredModels` (the
download affordance), from `unsatisfiedRequiredModels` (the degraded lane), and
from `requiredTagsFromHealth` (the first-run bar's denominator) — the same three
exclusions `disabled` already needs, for a different reason, which is the shape
that suggests the fourth and fifth state belong to one predicate rather than
being special-cased twice.

The first-run size sentence states the text model alone. It gains a second
sentence naming what is deferred and what it will cost, because a number that
shrinks by 3.3 GB without explanation is a promise the app will later break.

The release gate of #40 is unaffected and must stay so: deferring *when* a tag is
pulled has no bearing on whether that tag resolves and can do its job, and a tag
that is fetched later on a user's machine is if anything more exposed to being
withdrawn, not less.

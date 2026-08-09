---
status: accepted
---

# Required-model status asserts capability, not presence

`modelStatus()` decides whether a required model is usable by listing the tags
Ollama has installed and testing membership (`src/llm/sidecar.ts`). Presence is
the whole test. We will make required-model status assert that the tag can do the
job its **role** needs, and let a role the operator switched off leave the
required set entirely.

## Presence is not the property anyone cares about

The status probe exists to answer one question: *can the app do the work?* Tag
presence answers a different one, and the two came apart the moment the text
default stopped being multimodal.

`granite4.1:8b` reports `completion, tools` and no `vision`. Before #33 the
vision role inherited `MODEL_TEXT`, so on `main` the vision role resolved to that
tag, the tag was installed, `modelStatus()` said available, `health()` said
available, first run dismissed itself — and every `describeImage` call failed
with `Ollama /api/chat returned 400`. The install was complete. The **capability**
was missing, and nothing in the system could express the difference.

ADR-0009 already committed to the principle this violates — *"a partial install
must never read as ready"*. An install that is complete and incapable is the same
lie told a different way, and it is worse in one respect: there is nothing to
download, so every recovery path the app offers is a no-op.

## Four states, replacing the boolean

`available: boolean` becomes `status: 'ready' | 'missing' | 'incapable' |
'disabled'`, on both the sidecar's per-role status and `ModelHealth`.

The boolean is **replaced** rather than kept alongside a new field. Keeping both
would mean every producer sets two things that can disagree, and every consumer
picks one — and the disagreement would be silent, because `available: true` next
to `status: 'incapable'` is not a type error. Replacing it makes the compiler walk
every implementer of the capability contract, which is the growth law of
`AppApi` working in our favour rather than against us. The change stays additive
to `RuntimeHealth` itself, so no channel and no bridge handler move.

That argument had a hole when it was written, and closing it is part of this
decision. The compiler walked every implementer **it was pointed at** — and
`tsconfig.json` included only `src/**/*.ts`, while `npm test` runs the suites in
`e2e/` too. Those suites carry their own `AppApi` doubles, so one was left on the
old shape, feeding the renderer a payload with no `status` that read as ready by
accident. A `tsconfig.e2e.json` now type-checks that tree with the same
strictness, wired into `npm run verify`. A coercion argument is only as good as
the set of files the coercion actually reaches.

`installCommand` is renamed to `recovery` in the same step. For an incapable
model the string is not an install command and must not be one — the tag is
already installed, and telling the user to pull it again sends them round a loop
that cannot terminate. A field whose name asserts a shape its contents no longer
have is a trap for the next reader.

## Capability belongs to the role, not to the tag

Each required role declares what it needs of whatever tag fills it: `text`
requires `completion` and `tools`, `vision` requires `completion` and `vision`.
The probe asks Ollama what a tag can do (`/api/show` returns a `capabilities`
array) and compares against the role's declaration.

Declaring it per role rather than per tag is what makes the check survive its own
purpose. A per-tag allowlist would have to be edited every time `scripts/model-eval/`
promotes a different vision model — and the edit would be invisible if forgotten,
because the new tag would simply not be checked. A per-role requirement also
catches the case no allowlist can: an operator's `MODEL_VISION` override pointing
at a text-only model. #33 already chose this axis for its live test; this extends
it from CI into the running app.

Requiring `tools` of the text role is the half that is easy to miss. The
orchestrator is a tool-calling loop; a text override without tool support fails
deep inside a turn with an error that names nothing useful. It is the same class
of bug as the vision one, one layer further in.

### A capability probe that fails is not evidence of incapability

If `/api/show` throws for a tag that *is* installed, the status falls back to
presence and reports `ready`. This is a deliberate asymmetry and it is the weakest
point of this decision, so it is recorded rather than buried.

Reporting `incapable` on a failed probe would tell a user with a perfectly good
configuration to go and change it, on the strength of a transient daemon hiccup —
and the recovery text for `incapable` is advice, not a command, so there is no
retry that clears it. The shipped defaults are guarded on two other surfaces
(#33's live capability test, and the release check of #40), so the fallback's blast
radius is an operator override on a sick daemon, which the runtime is already
reporting as degraded through `llm: false`. An empty `capabilities` array is a
real answer and is **not** treated as a probe failure.

## A disabled capability leaves the required set

`LLM_VISION_ENABLED=false` makes `describeImage` throw before it touches a model.
Until #33 that cost nothing, because the vision role inherited the text tag and
the required set deduplicated to one download. With two distinct tags it costs a
full ~3.3 GB pull, a readiness gate on a model nothing will call, and a first-run
screen quoting ~8.6 GB for a capability the operator has switched off.

The required set therefore becomes **derived from the configuration** rather than
fixed: `requiredModels()` returns the roles this configuration actually requires.
Provisioning, the readiness gate, the recovery string and the first-run size
sentence all read from that one derivation, so the narrowing lands everywhere at
once instead of in four places that can drift.

The counter-argument is ADR-0009's, and it is not wrong: vision takes the
**degraded** lane on purpose, because WCAG 1.1.1 suggestion is the flagship
capability and "ready" must not mean "ready except for that". A flag that can
silently drop it from the required set would produce exactly the fully-"ready" app
with no alt-text suggestion and nothing saying so.

So the set narrows **and** the state is surfaced. `disabled` is reported as one of
the four states rather than by dropping the role from the payload — a role that
vanishes from the health payload reads to the UI as "nothing missing", which is
the silent-hole failure restated. `disabled` does not mark the runtime degraded:
the operator chose it, and degrading on a deliberate choice trains people to
ignore the indicator.

The status probe reports one entry per required **role** — always both — while
the *pull* list is the narrowed set. Those are two different questions and
conflating them is what produced the 3.3 GB download for a disabled capability.

## The switch stays an environment variable

No UI affordance is added. This is an operator escape hatch for a machine that
will never describe an image; the shipped shape of the app is two required models.
A toggle in the interface would let an instructor disable the flagship capability
with one click and then wonder for a week why alt text stopped being offered.

## Consequences

`missingRequiredModels()` in the renderer must stop meaning "not available" and
start meaning "downloadable" — an incapable model must never appear in the
download affordance, because downloading is precisely what will not fix it. The
degraded lane widens to cover `incapable`; the download affordance narrows to
cover only `missing`.

The first-run size sentence and the pull bar's denominator follow the narrowed
set, so a disabled role contributes neither gigabytes to the estimate nor a
segment to the bar.

This decision is verifiable only against a real Ollama, because a fake that
returns whatever the fake was told is not evidence that the real capability
contract holds. The live test extends to point `MODEL_VISION` at the shipped text
model and assert readiness goes false — and that assertion must be watched failing
before the fix makes it pass. A health check that cannot express the failure it
exists to catch is the exact shape this repo has shipped before.

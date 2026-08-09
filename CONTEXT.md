# Canvas Agent

An on-device macOS app that helps instructors build and remediate Canvas LMS
content to WCAG 2.2 AA. Everything runs locally; course content and credentials
never leave the device.

## Language

### Models

**Model role**:
A named slot in the LLM configuration that resolves to a model tag. Five exist —
text, vision, fast, deep, cheap — but a role having a value does not mean the app
provisions it or calls it.
_Avoid_: model type, model slot

**Required model**:
A model the app cannot function without, and therefore provisions at first run
and gates readiness on. Normally two — text and vision — but the set is derived
rather than fixed: a capability the operator has switched off leaves it. A role
that is merely configured is not required; a required model that is installed but
cannot do its role's job is not satisfied.
_Avoid_: configured model, default model

**Role capability**:
What a role demands of whatever tag fills it — tool-calling for text, image input
for vision. A property of the role, not of the tag, so it outlives any particular
model. A tag being present says nothing about whether it has one.
_Avoid_: model feature, modality

**Provisional default**:
A shipped default tag that has not yet passed its promotion gate. Named so that
releasing it stays a decision someone makes rather than a step nobody notices.
_Avoid_: placeholder, temporary default

**Promotion gate**:
The evidence a candidate model must produce before it may become a default.
Measures the job the role actually performs — for vision, writing a text
alternative, not judging one.
_Avoid_: benchmark, eval (both name the activity, not the bar)

**Bundled models**:
Model weights shipped inside the application and read from it. Read-only — the
app never writes to them. Currently the document-conversion models only.
_Avoid_: embedded models, offline models

**First-run pull**:
Model weights fetched from a registry after installation, never redistributed
with the app, and stored per-user. Currently the two LLMs.
_Avoid_: first-run download — ambiguous, because bundling replaced a
same-named path for document models

### Accessibility

**Detection**:
Finding that content violates a success criterion. Deterministic — it does not
require a model.
_Avoid_: check, scan (both name the mechanism, not the finding)

**Suggestion**:
Proposing replacement content for a detected violation. Model-generated, and
therefore the surface where model quality is user-visible.
_Avoid_: fix, remediation (both imply the change has been applied)

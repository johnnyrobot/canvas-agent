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
and gates readiness on. There are exactly two: the text model and the vision
model. A role that is merely configured is not required.
_Avoid_: configured model, default model

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

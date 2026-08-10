---
status: accepted
---

# How a vision default is chosen

`RUNTIME_DEFAULT_VISION_MODEL` was declared on three checks — it resolves, it
reports `vision`, its licence is permissive — and on no evidence at all about the
only thing it does. We will require a vision default to clear an **alt-suggestion
gate** before it ships, and we will not let the gate that already exists stand in
for one.

## The existing eval scores the wrong job

`deps.ts` said the tag was decided by `scripts/model-eval/`. It could not have
been.

That harness answers a different question — whether a PDF-trained LoRA transfers
to Canvas HTML — and it shows: its arms are `gemma4:e2b` (a *retired* text
default), `minicpm-v4.6`, and the `remedy-*` adapters. No vision candidate is
among them.

Worse, its `alt` task gates on `minStatusAccuracy`, and that metric scores
**detection**: *does this image have adequate alt?* This app already answers that
deterministically, with axe-core and the PR #10 detections, and needs no model to
do it. The one thing a vision model is for — *writing* the replacement string —
is scored nowhere. Its corpus makes the same point: five `alt` fixtures, of which
four are the same SVG bar chart with the alt attribute varied. As a suggestion
corpus that is **one describable image**.

The project's own glossary had already drawn this line. **Detection** and
**Suggestion** are separate terms in `CONTEXT.md`, distinguished precisely by
whether a model is involved. The harness had simply never been held against the
vocabulary.

## The gate measures suggestion, and the control arm is not optional

A candidate is judged on alt text it actually writes, for images of the kinds
instructors post, with the surrounding page context supplied — correct alt depends
on context.

Every run includes a **text-only control arm** that must fail. A gate that cannot
demonstrate it detects a model that cannot see proves nothing when it goes green,
and this repo has shipped a green suite over a broken path before. The control is
a precondition for reading the candidate's result at all: if it passes, the run is
reported VOID rather than as a candidate result.

Two harness bugs found on the first live runs are recorded because both produced
a **wrong verdict about a model**, which is the failure mode this gate exists to
avoid in the product:

1. The required-text check compared with spacing intact. The candidate had read a
   syllabus perfectly and emitted `Room214`; the gate called that unread content
   and reported FAIL. Spacing is a formatting complaint — the rule asks only
   whether the pixels were read.
2. Two fixtures leaked their required strings into the page context they handed
   the model. The model echoed the context back verbatim as its "alt text" and
   **passed**, because the words the check looked for were in the echo. A required
   string must be readable only from the pixels. There is now a corpus-integrity
   test asserting exactly that; without it the gate's only teeth are removable by
   accident.

## The floor is a hard filter, not a score

The gate's deterministic half checks for alt text that is *actively worse than no
suggestion*: empty on an informative image, over-length, `"image of…"` boilerplate,
a filename, a looping phrase, a narrated decorative graphic, or — the one with
teeth — failing to reproduce text that is rendered in the image.

Failing any rule on any fixture disqualifies the candidate. Averaging is what lets
a model that invents an exam date get promoted on the strength of nine competent
charts. The categories are not equal and must not be pooled: a wrong description
of a chart is a bad suggestion an instructor can see is wrong, while a confident
wrong reading of a scanned exam page is fiction they cannot detect and will paste.

## What was actually run, and what it is worth

The release date moved to "now" before the full corpus existed. Rather than ship
on no evidence or delay, we ran a **reduced** gate: ten rendered images and the
deterministic floor only — no adjudicated adequacy judgement, no human review pass,
no real scans.

It changed the answer, which is the argument for having run it:

| arm | floor | runs |
|---|---|---|
| `qwen3-vl:4b` | PASS | 3 of 3 |
| `hf.co/…/granite-vision-4.1-4b-GGUF:Q4_K_M` | FAIL | 0 of 2 |
| `granite4.1:8b` (control) | FAIL, 10/10 fixtures | every run |

The outgoing default narrated a decorative divider every run, and intermittently
returned the supplied page context verbatim instead of reading the image. Alt text
that repeats what the screen-reader user just heard is not a text alternative.

**The reduced gate is necessary and not sufficient**, and the distinction must
survive this decision:

- Ten images cannot separate reliable from lucky. A failure is strong evidence; a
  pass is weak evidence.
- Every image is **rendered**, not photographed. Crisp vector text is a far easier
  read than a phone photo of a syllabus — the highest-stakes real case is the one
  least represented.
- The floor says "not harmful". It does not say "good", and it does not rank two
  passing models against each other.

Two known quality gaps cleared the floor and are recorded rather than fixed: the
shipped model answers an equation in LaTeX (unusable read aloud), and it advertises
a `thinking` capability — the class of model that can spend its whole token budget
reasoning and return empty, which this repo has hit before.

## Consequences

`scripts/alt-gate/` is the gate, separate from `scripts/model-eval/`, which keeps
its own question. The floor is pure and unit-tested offline; the run needs a local
Ollama and drives the model through the app's own `describeImage`, so a pass means
the real path works rather than that a request shaped for the harness did.

The full gate remains open as #42/#43: 20–30 human-sourced images including real
scans, an adjudicated adequacy judgement with human review of disagreements, and
a ranked comparison. Until that runs, no one may claim this app's alt-text
suggestions are *good* — only that they cleared a floor.

A library-resolvable tag is the tiebreak among candidates that clear the floor.
The `hf.co/…` form the previous default required depends on an upstream repository
that can be renamed after we ship, which would strand the `ollama pull` recovery
command the app prints to a user whose automated download already failed.

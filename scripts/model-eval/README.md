# Three-arm model eval

Answers one question: **on Canvas HTML, which model can be trusted with the
judgment calls canvas-agent delegates to an LLM?**

```bash
npx tsx scripts/model-eval/run.ts                       # all tasks, all arms
npx tsx scripts/model-eval/run.ts --tasks contrast      # one task
npx tsx scripts/model-eval/run.ts --arms generalist     # one arm
npx tsc -p tsconfig.scripts.json                        # typecheck (scripts/ is NOT in the default tsconfig)
npx tsx --test scripts/model-eval/score.test.ts         # 37 scorer unit tests
```

Fully offline. Needs a local Ollama with `gemma4:e2b`, `minicpm-v4.6`, and the
`remedy-*-v1` adapter models (see "Registering the adapters" below).

## The arms

| Arm | Model | What it isolates |
|---|---|---|
| `generalist` | `gemma4:e2b` | The shipped default. Untuned. |
| `base` | `minicpm-v4.6` | The adapters' base, **no adapter**. Separates what the LoRA adds from what the base already knew. |
| `adapter` | `remedy-<task>-v1` | The task-tuned LoRA from `remedy-pdf-desktop`. Measures **cross-domain transfer**: trained on PDF page renders, tested on Canvas HTML renders. |

The `base` arm is the one that makes the result interpretable. Without it, an
adapter win is unattributable — you can't tell whether the LoRA earned it or the
base model was always better than the generalist.

## Why the tasks/prompts look like PDF tooling

The prompts are ported from remedy's PDF harness, keeping the **shape** (section
order, the numbered element list, the inlined JSON block) and swapping only the
domain nouns. That port is cheap because remedy's tag vocabulary is already
HTML-shaped: heading corrections are `H1`–`H6`/`P`/`Span`, tables are judged on
`TH` cells, images on Figure-with-alt. A DOM element list is isomorphic to the
PDF structure tree the adapters read.

Scoring is a faithful port of remedy's `metrics.py` (see
`.frugal-fable/eval-spec/remedy-eval-contracts.md`, which cites it line by line),
so the numbers are directly comparable to remedy's own promotion gates.

`reading_order` is deliberately **not** ported: canvas-agent has no such
dimension, and remedy's `corrected_order_accuracy` is dead code against its own
v4 corpus.

## Two traps, both already hit

1. **`think: false` is load-bearing** (`arms.ts`). MiniCPM-V 4.6 is a
   hybrid-reasoning model. Left on, it spends the *entire* `num_predict` budget
   inside a `<think>` block and returns **empty content** — which scores as
   "invalid JSON" and reads as a catastrophic model failure when it is really a
   harness failure. Measured: ~2,400 chars of thinking, 0 chars of answer, and a
   bogus `base` score of 0% valid JSON. Remedy's own V4 notes record the same
   class of bug ("all the invalid-JSON records were truncation artifacts").
2. **heading needs `num_predict: 1024`**, not the 768 the other tasks use
   (`contracts.ts` `MAX_TOKENS`). Multi-finding pages truncate mid-JSON at lower
   budgets, and the truncation is indistinguishable from a real parse failure.

Both mean the same thing: **an "invalid JSON" result is a harness suspect before
it is a model verdict.** Check the raw text in `predictions.jsonl` first.

## Fairness

Every arm gets the identical prompt, the identical grammar-constrained `format`
schema, `temperature: 0`, and `think: false`. The only variable is the model.

The schema is inlined in the prompt *and* enforced by `format` for all arms
deliberately: the adapters learned the output schema during training and the
generalist never saw it, so withholding it would measure format memorization
rather than accessibility judgment — which is the thing under test.

## Corpus

`corpus.ts` — 18 Canvas-styled fixtures, each with one deliberate accessibility
property and a gold answer in the task's schema. Every fixture carries a
`rationale` naming its WCAG basis, so the gold is auditable rather than asserted.
It includes near-threshold contrast cases (ratios inside `[4.2, 4.8]`, e.g.
`#7a7a7a` = 4.37:1 fail vs `#767676` = 4.54:1 pass) — the band where a real
adjudicator earns its keep, and the only way `nearThresholdStatusAccuracy` is
non-null.

This is a seed corpus sized to answer "does this model belong in the product",
**not** a training set. Grow it from real Canvas exports before promoting
anything on the strength of these numbers.

## Registering the adapters

The LoRAs live as GGUF in the remedy repo's packaging spike. Register each with
Ollama once (they share one 1.6 GB base; each adapter adds ~6 MB):

```bash
GGUF=/Users/laccd/code/remedy-pdf-desktop/tools/minicpm_edge/eval_runs/packaging_spike_mac/gguf
for t in alt contrast heading table; do
  printf 'FROM minicpm-v4.6:latest\nADAPTER %s/%s-v1.gguf\n' "$GGUF" "$t" > /tmp/Modelfile.$t
  ollama create "remedy-$t-v1" -f /tmp/Modelfile.$t
done
```

## Artifacts

`--out <dir>` (default `.frugal-fable/eval-runs/latest`) gets:
- `metrics.json` — per (task, arm) metrics + gate results
- `predictions.jsonl` — every raw model response (**read this before believing a
  bad score**)
- `renders/` — the PNG each model actually saw

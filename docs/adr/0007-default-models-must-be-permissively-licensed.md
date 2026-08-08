---
status: accepted
---

# Default models must be permissively licensed

The app's default text model is `gemma4:e2b` (`src/runtime/deps.ts:61`), whose
weights are governed by Google's **Gemma Terms of Use** and **Prohibited Use
Policy**. We will require every model the app defaults to — every tag in the
required set of ADR-0009 — to be permissively licensed (Apache-2.0 or MIT), and
enforce it with a test rather than with review discipline.

## The reason is procurement, not redistribution

This is the part a future reader will get wrong, because the obvious argument is
the invalid one.

Gemma is **already** pulled by Ollama at runtime and has never been redistributed
inside the app — `THIRD-PARTY-NOTICES.md` §"Model weights used at runtime (NOT
redistributed)" says so today. So switching defaults buys nothing on the
redistribution axis. There was no redistribution to avoid, and any argument
phrased that way is describing the status quo.

What the constraint actually buys: an Apache-2.0 tool stops **steering every user
into accepting a third-party acceptable-use policy** as the price of first run.
Canvas Agent ships to community-college instructors, and a district that reviews
software before deployment will ask what terms attach to the model the app
downloads on their behalf. "None beyond Apache-2.0" is an answer. "Google's
Prohibited Use Policy, which your users accept implicitly by clicking Download"
is a conversation.

## Considered options

**Choose on capability alone.** Rejected, but not because capability is
unimportant — see ADR-0009 and `scripts/model-eval/`, which decides *which* of
the permissively-licensed candidates ships. Licence is a filter applied first;
capability decides within what survives. Inverting the order would mean
discovering late that the best-scoring model cannot ship.

**Keep Gemma and document the terms.** Rejected. It is defensible, and it is what
we do today. But the terms would attach to the *default* path — the one taken by
every user who never opens settings — which makes the disclosure a footnote on
something nobody chose.

## Consequences

The constraint is a hard filter, and it bites immediately: it eliminates
`llama3.2-vision` (Llama Community License plus its own acceptable-use policy)
from the vision candidates, leaving `granite3.2-vision`, `qwen3-vl`, `moondream`,
and `hf.co/ibm-granite/granite-vision-4.1-4b-GGUF` — all Apache-2.0 and ungated,
verified from their model cards rather than from secondary claims.

`src/llm/config.ts:9` holds a second, different Gemma default
(`DEFAULT_MODEL = 'gemma4:12b-mlx'`). It is unreachable in the packaged app
because `runtimeLlmEnv()` always sets `MODEL_TEXT`, but it is what tests,
`npm run llm:smoke`, and any future non-runtime caller fall back to. It is
retired by this decision: a licence-encumbered fallback sitting in the tree of an
app that switched defaults *for licence reasons* is a trap, not an untidiness.

Shipping defaults consolidate into `runtimeLlmEnv()` (`src/runtime/deps.ts:64`),
which sets `MODEL_VISION` alongside `MODEL_TEXT`. This preserves the convention
stated at `deps.ts:58` — *"We never edit `src/llm`; we steer model selection
through the existing env-override mechanism"* — and gives the guard test a single
place to assert against. Putting the vision default in `src/llm/config.ts`
instead would have broken that convention and split the defaults across two
modules.

The guard test asserts every shipped default tag is on a permissive-licence
allowlist. It is deliberately a test and not a comment: this constraint is
invisible in the code it governs (a model tag is just a string), so nothing else
would catch a future default that quietly reintroduces encumbered weights.

/**
 * The three arms. Each is one Ollama model tag; the difference is what's loaded
 * behind it:
 *
 *   generalist — gemma4:e2b, the shipped default. Untuned on this task.
 *   base       — minicpm-v4.6, the adapters' base model with NO adapter.
 *                Isolates what the LoRA adds from what the base already knew.
 *   adapter    — remedy-<task>-v1, the task-tuned LoRA (shared base + ~6 MB).
 *                Measures cross-domain transfer: trained on PDF page renders,
 *                tested here on Canvas HTML renders.
 *
 * All arms get the identical prompt, the identical grammar-constrained schema,
 * and temperature 0 (remedy decodes greedily — `do_sample=False`). The only
 * variable is the model. That is the point.
 */
import { readFile } from 'node:fs/promises';
import type { ArmKind, RenderedFixture, Prediction, TaskKey } from './types.ts';
import { PROMPTS, SCHEMAS, MAX_TOKENS, ADAPTER_MODEL, type PageStructure } from './contracts.ts';

const OLLAMA = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

/** Which model tag serves this (arm, task) pair. */
export function modelFor(arm: ArmKind, task: TaskKey): string {
  switch (arm) {
    case 'generalist':
      return process.env.EVAL_GENERALIST ?? 'gemma4:e2b';
    case 'base':
      return process.env.EVAL_BASE ?? 'minicpm-v4.6:latest';
    case 'adapter':
      return ADAPTER_MODEL[task];
  }
}

export const armLabel = (arm: ArmKind, task: TaskKey): string => `${arm}:${modelFor(arm, task)}`;

/** One (fixture, arm) call. Never throws: a transport failure is recorded as an
 *  unparseable prediction, which is exactly how the scorer should see it. */
export async function predict(
  arm: ArmKind,
  fixture: RenderedFixture,
  structure: PageStructure,
  timeoutMs = 300_000,
): Promise<Prediction> {
  const task = fixture.task;
  const model = modelFor(arm, task);
  const image = await readFile(fixture.pngPath);
  const body = {
    model,
    stream: false,
    format: SCHEMAS[task],
    // MUST stay false. MiniCPM-V 4.6 is a hybrid-reasoning model: left on, it
    // spends the entire `num_predict` budget inside a <think> block and returns
    // EMPTY content — which scores as "invalid JSON" and looks like a model
    // failure when it is really a harness failure. (Measured: ~2.4k chars of
    // thinking, 0 chars of answer.) Remedy serves these adapters greedy with no
    // thinking, so this also keeps us faithful to their config — and holds
    // conditions equal across all three arms.
    think: false,
    options: { temperature: 0, num_predict: MAX_TOKENS[task] },
    messages: [
      {
        role: 'user',
        content: PROMPTS[task](structure),
        images: [image.toString('base64')],
      },
    ],
  };

  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { message?: { content?: string } };
    return {
      fixtureId: fixture.id,
      task,
      arm: armLabel(arm, task),
      raw: json.message?.content ?? '',
      parsed: null, // filled by the scorer via parseJsonish — keep raw authoritative
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return {
      fixtureId: fixture.id,
      task,
      arm: armLabel(arm, task),
      raw: '',
      parsed: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

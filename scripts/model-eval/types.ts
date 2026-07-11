/**
 * Three-arm model eval — shared contract.
 *
 * Question this harness answers: on **Canvas HTML** (not the PDF renders the
 * remedy adapters were trained on), which model can be trusted with the
 * judgment calls canvas-agent actually delegates to an LLM?
 *
 * The three arms:
 *   1. `generalist`  — the shipped default (gemma4:e2b). Untuned.
 *   2. `base`        — MiniCPM-V-4.6 with no adapter. Isolates what the
 *                      adapters add from what the base model already knows.
 *   3. `adapter`     — the task-tuned remedy LoRA for the task under test.
 *                      Measures cross-domain transfer (PDF renders → Canvas).
 *
 * Scoring is a faithful port of the remedy harness so numbers are comparable
 * against its promotion gates. See `.frugal-fable/eval-spec/remedy-eval-contracts.md`
 * for the source-of-truth contracts (with file:line cites into that repo).
 */

/** The four tasks that map onto a real canvas-agent dimension.
 *  `reading_order` is deliberately absent: canvas-agent has no such dimension,
 *  and remedy's `corrected_order_accuracy` is dead code against its own v4
 *  corpus (spec §5.4). */
export type TaskKey = 'alt' | 'contrast' | 'heading' | 'table';

export const TASK_KEYS: readonly TaskKey[] = ['alt', 'contrast', 'heading', 'table'];

export type Status = 'pass' | 'fail';

export type ArmKind = 'generalist' | 'base' | 'adapter';

/** One eval case: a Canvas page and the answer we hold the model to. */
export interface Fixture {
  id: string;
  task: TaskKey;
  /** Full standalone HTML document (rendered to PNG, and used to derive the
   *  DOM element list the prompt interpolates). */
  html: string;
  /** Gold answer, in the task's output schema (see contracts.ts). */
  gold: unknown;
  /** Why this gold is correct — the WCAG basis. Keeps the corpus auditable. */
  rationale: string;
}

export interface RenderedFixture extends Fixture {
  /** Absolute path to the rendered PNG. */
  pngPath: string;
}

export interface Prediction {
  fixtureId: string;
  task: TaskKey;
  /** Arm label, e.g. "generalist:gemma4:e2b" or "adapter:remedy-alt-v1". */
  arm: string;
  /** Raw model text, unparsed (remedy stores this too — keeps failures debuggable). */
  raw: string;
  /** `parse_jsonish` result: null on parse failure. This is what `validJson` measures. */
  parsed: unknown | null;
  latencyMs: number;
  error?: string;
}

/** Per-row score. Mirrors `score_one` (remedy metrics.py:137-174). */
export interface RowScore {
  fixtureId: string;
  task: TaskKey;
  validJson: boolean;
  goldStatus: Status | null;
  predStatus: Status | null;
  /** Requires goldStatus !== null && predStatus === goldStatus. */
  statusMatch: boolean;
  /** goldStatus === 'pass' && predStatus === 'fail' — a false alarm on clean content. */
  passFalsePositive: boolean;
  /** contrast only: any ratio (gold ∪ pred) within [4.2, 4.8]. */
  nearThreshold?: boolean;
  /** heading only: set-equality of (element_index, correct_tag) pairs. */
  exactCorrections?: boolean;
}

export interface GateResult {
  name: string;
  expected: string;
  observed: number | null;
  passed: boolean;
}

/** Aggregate metrics. Mirrors `summarize` (remedy metrics.py:177-226). */
export interface TaskMetrics {
  task: TaskKey;
  arm: string;
  n: number;
  validJsonRate: number;
  statusAccuracy: number;
  passFalsePositiveRate: number;
  /** contrast only; null when no row is near-threshold. */
  nearThresholdStatusAccuracy: number | null;
  /** heading only; computed over gold-fail rows only; null when none. */
  exactCorrectionAccuracy: number | null;
  /** "gold->pred" → count. */
  confusion: Record<string, number>;
  gates: GateResult[];
  medianLatencyMs: number;
}

/** Promotion gates, ported verbatim from remedy constants.py:39-133.
 *  Global: validJsonRate >= 0.90, passFalsePositiveRate <= 0.10. */
export const GATES: Record<TaskKey, {
  minStatusAccuracy: number;
  minExactCorrectionAccuracy?: number;
  minNearThresholdAccuracy?: number;
}> = {
  alt: { minStatusAccuracy: 0.9 },
  contrast: { minStatusAccuracy: 0.9, minNearThresholdAccuracy: 0.85 },
  heading: { minStatusAccuracy: 0.95, minExactCorrectionAccuracy: 0.85 },
  table: { minStatusAccuracy: 1.0 },
};

export const GLOBAL_GATES = { minValidJsonRate: 0.9, maxPassFalsePositiveRate: 0.1 };

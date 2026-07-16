/**
 * Pure scoring functions for the three-arm model eval — a faithful TypeScript
 * port of the remedy PDF harness's `minicpm_edge/metrics.py`, so numbers
 * computed here are comparable against that harness's promotion gates.
 *
 * Source-of-truth contract (every formula below cites a section):
 *   `.frugal-fable/eval-spec/remedy-eval-contracts.md`
 *     §0.6 parse_jsonish, §0.8 score_one, §0.9 summarize,
 *     §1.4 alt, §2.4 contrast, §3.4 table, §4.4 heading.
 *
 * Porting principle: fidelity over improvement. Where the Python source
 * does something odd (e.g. `or`-chained key fallbacks, silent int()
 * truncation), this port replicates the *observable behavior*, not just the
 * spirit of it — see the `pyOr` / `toIntStrict` helpers below.
 *
 * Pure: no I/O, no network, no fs. Safe to unit test directly.
 */

import type {
  GateResult,
  Prediction,
  RowScore,
  Status,
  TaskKey,
  TaskMetrics,
} from './types.js';
import { GATES, GLOBAL_GATES } from './types.js';

// ---------------------------------------------------------------------------
// §0.6 parse_jsonish
// ---------------------------------------------------------------------------

/**
 * Strips a leading/trailing markdown code fence (```` ```json ... ``` ````)
 * then `JSON.parse`s the remainder. Returns `null` (never throws) on any
 * parse failure, mirroring `minicpm_edge/metrics.py:12-22`.
 */
export function parseJsonish(raw: string): unknown | null {
  let text = raw.trim();

  if (text.startsWith('```')) {
    // Strip an opening fence, optionally tagged (```json, ```JSON, ...).
    text = text.replace(/^```[a-zA-Z0-9]*\s*\n?/, '');
    // Strip a trailing fence if present.
    if (text.endsWith('```')) {
      text = text.replace(/\n?```$/, '');
    }
    text = text.trim();
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function getArrayField(obj: unknown, key: string): unknown[] | undefined {
  if (!isPlainObject(obj)) return undefined;
  const val = obj[key];
  return Array.isArray(val) ? val : undefined;
}

/** Python truthiness, for replicating `a or b or c` fallback chains. */
function isPyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === 0) return false;
  if (typeof v === 'number' && Number.isNaN(v)) return false;
  if (v === '') return false;
  return true;
}

/** Mirrors Python's `a or b or c or ...`: first truthy operand, else the
 *  last operand (falsy) — never throws, never coerces types. */
function pyOr(...vals: unknown[]): unknown {
  for (const v of vals) {
    if (isPyTruthy(v)) return v;
  }
  return vals[vals.length - 1];
}

/**
 * Mirrors Python's `int(x)` well enough for the values that actually appear
 * in these JSON payloads: numbers truncate toward zero (int() truncates a
 * float), integer-looking strings parse, booleans coerce (bool is an int
 * subclass in Python), everything else (including non-integer strings,
 * null/undefined, objects) is treated as a failure and the item is skipped
 * — matching "any exception -> item skipped" in the spec.
 */
function toIntStrict(val: unknown): number | null {
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return null;
    return Math.trunc(val);
  }
  if (typeof val === 'boolean') {
    return val ? 1 : 0;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (/^[+-]?\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
    return null;
  }
  return null;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// §0.8 normalized_status
// ---------------------------------------------------------------------------

/**
 * Mirrors `normalized_status()` (`metrics.py:58-79`). Fallback chain:
 *   1. not an object -> null
 *   2. literal `status` key ("pass"/"fail", case-insensitive, trimmed)
 *   3. task === 'alt': derived from `figures[]` (or `issues[]` alt key) —
 *      "fail" if ANY entry's status is in {fail, failed, error}, else
 *      "pass". This branch is exhaustive for `alt` (always resolves to
 *      pass/fail, never falls through to 4/5).
 *   4. `issues[]` present -> "fail" if non-empty else "pass" (contrast).
 *   5. `findings[]` present -> "fail" if non-empty else "pass" (heading).
 *   6. else -> null.
 */
export function normalizedStatus(parsed: unknown, task: TaskKey): Status | null {
  if (!isPlainObject(parsed)) return null;

  const statusVal = parsed['status'];
  if (typeof statusVal === 'string') {
    const s = statusVal.trim().toLowerCase();
    if (s === 'pass' || s === 'fail') return s;
  }

  if (task === 'alt') {
    const list = getArrayField(parsed, 'figures') ?? getArrayField(parsed, 'issues') ?? [];
    const anyFail = list.some((item) => {
      if (!isPlainObject(item)) return false;
      const st = item['status'];
      return st === 'fail' || st === 'failed' || st === 'error';
    });
    return anyFail ? 'fail' : 'pass';
  }

  const issues = getArrayField(parsed, 'issues');
  if (issues) {
    return issues.length > 0 ? 'fail' : 'pass';
  }

  const findings = getArrayField(parsed, 'findings');
  if (findings) {
    return findings.length > 0 ? 'fail' : 'pass';
  }

  return null;
}

// ---------------------------------------------------------------------------
// §2.4 contrast_ratios
// ---------------------------------------------------------------------------

/**
 * Mirrors `contrast_ratios()` (`metrics.py:120-134`): reads `issues` (or
 * `contrast_issues` as a fallback key), collects `Number(item.ratio)` per
 * entry, skipping any that don't coerce to a finite number.
 */
export function contrastRatios(parsed: unknown): number[] {
  const list = getArrayField(parsed, 'issues') ?? getArrayField(parsed, 'contrast_issues') ?? [];
  const ratios: number[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const num = Number(item['ratio']);
    if (Number.isFinite(num)) ratios.push(num);
  }
  return ratios;
}

// ---------------------------------------------------------------------------
// §4.4 heading_pairs
// ---------------------------------------------------------------------------

const HEADING_TAG_RE = /^(H[1-6]|P|SPAN)$/;
const HEADING_ALIAS_KEYS = ['findings', 'heading_corrections', 'corrections', 'heading_issues', 'issues'];

/**
 * Mirrors `heading_pairs()` (`metrics.py:82-102`). Concatenates items from
 * every alias key present, reads `element_index` (or `index`/`element`,
 * `or`-chained), reads the correction tag (`correct_tag`/`target_tag`/
 * `expected_tag`, `or`-chained), strips a leading `/`, uppercases, keeps
 * only tags fullmatching `H[1-6]|P|SPAN` (SPAN normalized to `Span`), and
 * serializes each surviving `(index, tag)` pair as `${index}|${tag}` into a
 * Set (dedup; order irrelevant).
 */
export function headingPairs(parsed: unknown): Set<string> {
  const items: unknown[] = [];
  for (const key of HEADING_ALIAS_KEYS) {
    const arr = getArrayField(parsed, key);
    if (arr) items.push(...arr);
  }

  const pairs = new Set<string>();
  for (const item of items) {
    if (!isPlainObject(item)) continue;

    const idxRaw = pyOr(item['element_index'], item['index'], item['element']);
    const idx = toIntStrict(idxRaw);
    if (idx === null) continue;

    const tagRaw = pyOr(item['correct_tag'], item['target_tag'], item['expected_tag'], '');
    const tagStr = typeof tagRaw === 'string' ? tagRaw : String(tagRaw);
    let tag = tagStr.replace(/^\//, '').toUpperCase();
    if (!HEADING_TAG_RE.test(tag)) continue;
    if (tag === 'SPAN') tag = 'Span';

    pairs.add(`${idx}|${tag}`);
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// §0.8 score_one
// ---------------------------------------------------------------------------

/**
 * Mirrors `score_one(task, gold, pred)` (`metrics.py:137-174`). `gold`/`pred`
 * are already `parseJsonish`-parsed values (an object, or `null` on parse
 * failure) — matching `Prediction.parsed` in types.ts.
 */
export function scoreOne(task: TaskKey, gold: unknown, pred: unknown, fixtureId: string): RowScore {
  const goldStatus = normalizedStatus(gold, task);
  const predStatus = normalizedStatus(pred, task);

  const validJson = pred !== null;
  const statusMatch = goldStatus !== null && predStatus === goldStatus;
  const passFalsePositive = goldStatus === 'pass' && predStatus === 'fail';

  const row: RowScore = {
    fixtureId,
    task,
    validJson,
    goldStatus,
    predStatus,
    statusMatch,
    passFalsePositive,
  };

  if (task === 'contrast') {
    const pooled = [...contrastRatios(gold), ...contrastRatios(pred)];
    row.nearThreshold = pooled.some((ratio) => ratio >= 4.2 && ratio <= 4.8);
  }

  if (task === 'heading') {
    row.exactCorrections = setsEqual(headingPairs(gold), headingPairs(pred));
  }

  return row;
}

// ---------------------------------------------------------------------------
// Gate evaluation (feeds TaskMetrics.gates)
// ---------------------------------------------------------------------------

function computeGates(
  task: TaskKey,
  m: {
    validJsonRate: number;
    statusAccuracy: number;
    passFalsePositiveRate: number;
    nearThresholdStatusAccuracy: number | null;
    exactCorrectionAccuracy: number | null;
  },
): GateResult[] {
  const gates: GateResult[] = [];
  const taskGate = GATES[task];

  gates.push({
    name: 'validJsonRate',
    expected: `>= ${GLOBAL_GATES.minValidJsonRate}`,
    observed: m.validJsonRate,
    passed: m.validJsonRate >= GLOBAL_GATES.minValidJsonRate,
  });

  gates.push({
    name: 'passFalsePositiveRate',
    expected: `<= ${GLOBAL_GATES.maxPassFalsePositiveRate}`,
    observed: m.passFalsePositiveRate,
    passed: m.passFalsePositiveRate <= GLOBAL_GATES.maxPassFalsePositiveRate,
  });

  gates.push({
    name: 'statusAccuracy',
    expected: `>= ${taskGate.minStatusAccuracy}`,
    observed: m.statusAccuracy,
    passed: m.statusAccuracy >= taskGate.minStatusAccuracy,
  });

  if (taskGate.minNearThresholdAccuracy !== undefined) {
    const observed = m.nearThresholdStatusAccuracy;
    gates.push({
      name: 'nearThresholdStatusAccuracy',
      expected: `>= ${taskGate.minNearThresholdAccuracy}`,
      observed,
      // A gate whose observed value is null (no near-threshold rows) must
      // never be silently treated as a pass.
      passed: observed !== null && observed >= taskGate.minNearThresholdAccuracy,
    });
  }

  if (taskGate.minExactCorrectionAccuracy !== undefined) {
    const observed = m.exactCorrectionAccuracy;
    gates.push({
      name: 'exactCorrectionAccuracy',
      expected: `>= ${taskGate.minExactCorrectionAccuracy}`,
      observed,
      passed: observed !== null && observed >= taskGate.minExactCorrectionAccuracy,
    });
  }

  return gates;
}

// ---------------------------------------------------------------------------
// §0.9 summarize
// ---------------------------------------------------------------------------

/**
 * Mirrors `summarize()` (`metrics.py:177-226`). `validJsonRate`,
 * `statusAccuracy`, `passFalsePositiveRate` are plain means over ALL rows
 * (a row whose gold status can't be normalized scores 0 for `statusMatch`
 * — it is never excluded from the denominator).
 */
export function summarize(
  task: TaskKey,
  arm: string,
  rows: RowScore[],
  latenciesMs: number[],
): TaskMetrics {
  const n = rows.length;

  const validJsonRate = round4(mean(rows.map((r) => (r.validJson ? 1 : 0))));
  const statusAccuracy = round4(mean(rows.map((r) => (r.statusMatch ? 1 : 0))));
  const passFalsePositiveRate = round4(mean(rows.map((r) => (r.passFalsePositive ? 1 : 0))));

  const confusion: Record<string, number> = {};
  for (const r of rows) {
    const key = `${r.goldStatus}->${r.predStatus}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }

  const nearThresholdRows = rows.filter((r) => r.nearThreshold === true);
  const nearThresholdStatusAccuracy =
    nearThresholdRows.length > 0
      ? round4(mean(nearThresholdRows.map((r) => (r.statusMatch ? 1 : 0))))
      : null;

  const failRows = rows.filter((r) => r.goldStatus === 'fail');
  const exactCorrectionAccuracy =
    failRows.length > 0
      ? round4(mean(failRows.map((r) => (r.exactCorrections ? 1 : 0))))
      : null;

  const medianLatencyMs = median(latenciesMs);

  const gates = computeGates(task, {
    validJsonRate,
    statusAccuracy,
    passFalsePositiveRate,
    nearThresholdStatusAccuracy,
    exactCorrectionAccuracy,
  });

  return {
    task,
    arm,
    n,
    validJsonRate,
    statusAccuracy,
    passFalsePositiveRate,
    nearThresholdStatusAccuracy,
    exactCorrectionAccuracy,
    confusion,
    gates,
    medianLatencyMs,
  };
}

// Re-exported only so callers of this module (a future eval driver) can
// build `Prediction`-shaped rows without a second import; not part of the
// scoring contract itself.
export type { Prediction };

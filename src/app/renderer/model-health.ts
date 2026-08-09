/**
 * Reading the required-model half of `RuntimeHealth` — DOM-free, so the
 * two-model behaviour is covered by fast unit tests rather than only by an
 * end-to-end run (the `ui-theme.ts` / `catalog-view.ts` pattern).
 *
 * The app requires exactly two models, text and vision (ADR-0009), reported as
 * sibling fields. Missing EITHER marks the runtime degraded: alt-text detection
 * is deterministic and survives without a vision model, but WCAG 1.1.1
 * suggestion is the flagship capability, and "ready" must not mean "ready except
 * for that".
 */
import type { ModelHealth, ModelPullProgress, RuntimeHealth } from '../../contracts/index.js';

/** The half of `RuntimeHealth` this module reads. */
type RequiredModelHealth = Pick<RuntimeHealth, 'model' | 'visionModel'>;

/**
 * Approximate download size, in GB, of each model tag the app ships as a default
 * — what first run tells the instructor BEFORE the download starts, so they can
 * decide whether now is the moment (ADR-0009).
 *
 * Declared here rather than read from the runtime because the renderer cannot
 * import runtime code, and because the size is not on the health contract: it is
 * a property of the tag, not of the machine. A shipped default missing from this
 * table fails the guard in `src/runtime/deps.test.ts` — the pair of that table's
 * licence guard, and for the same reason: a model tag is only a string.
 *
 * Sizes are the published download sizes, not the on-disk footprint after
 * unpacking. `RUNTIME_DEFAULT_MODEL` in `src/runtime/deps.ts` argues the same
 * figures in prose (they are the sizing case for 16 GB Macs) — the two move
 * together, and the guard test is what forces a new default through here.
 *
 * The two entries are the required set of ADR-0009, text then vision: ~8.6 GB
 * total, which is the number first run states.
 */
export const MODEL_DOWNLOAD_SIZES_GB: Readonly<Record<string, number>> = {
  'granite4.1:8b': 5.3,
  'hf.co/ibm-granite/granite-vision-4.1-4b-GGUF:Q4_K_M': 3.3,
};

/**
 * The required models the runtime reports as missing — in role order (text
 * first), deduplicated by tag.
 *
 * Deduplication is for the configuration that collapses the two roles onto one
 * multimodal tag — not the shipping shape since #33, but there it is two
 * required roles with ONE download to offer and one tag to name.
 * A required model the runtime does not report at all is NOT counted as missing;
 * absent means "cannot report", which the caller already sees as an unreachable
 * sidecar.
 */
export function missingRequiredModels(health: RequiredModelHealth): ModelHealth[] {
  const seen = new Set<string>();
  const missing: ModelHealth[] = [];
  for (const model of [health.model, health.visionModel]) {
    if (model === undefined || model.available || seen.has(model.tag)) continue;
    seen.add(model.tag);
    missing.push(model);
  }
  return missing;
}

/** Status-line text naming which required models are missing (empty when none). */
export function missingModelsText(missing: readonly ModelHealth[]): string {
  if (missing.length === 0) return '';
  return `${plural(missing, 'Model')} not installed (${tagList(missing)})`;
}

/**
 * The tags the first-run pull will cover, as the runtime's health payload
 * reports them: the required models, deduplicated in role order — whether or not
 * they are installed. Named for its input because `src/llm/config.ts` has a
 * same-shaped `requiredModelTags` over `LLMConfig`; that one decides what to
 * pull, this one reads what was reported.
 *
 * This is the bar's DENOMINATOR, and it is deliberately not the missing set:
 * `pullModel` pulls the whole required set, so a model already present still
 * reports progress (a near-instant `success`). Dividing by the missing count
 * would let that no-op complete the bar while a multi-gigabyte download had not
 * yet started.
 */
export function requiredTagsFromHealth(health: RequiredModelHealth): string[] {
  const tags: string[] = [];
  for (const model of [health.model, health.visionModel]) {
    if (model !== undefined && !tags.includes(model.tag)) tags.push(model.tag);
  }
  return tags;
}

/**
 * The download affordance's visible text, its accessible name, and the size
 * sentence shown beside it. All three come from here so they cannot disagree
 * about how many models the button is about, or how large they are — the button
 * says "Download models" only when the label lists more than one.
 *
 * The size is stated up front because the wait is the thing users misjudge: on a
 * slow connection it is the difference between deciding to wait and force-quitting.
 *
 * `sizes` is a parameter so the arithmetic can be tested against a fixed table
 * — including the partial and empty cases, which the shipped table (where every
 * default declares a size, by guard test) cannot express. Callers pass nothing.
 */
export function downloadModelAffordance(
  missing: readonly ModelHealth[],
  sizes: Readonly<Record<string, number>> = MODEL_DOWNLOAD_SIZES_GB,
): { text: string; label: string; sizeText: string } {
  const size = sizePhrase(missing, sizes);
  const label =
    missing.length === 1
      ? `Download model ${tagList(missing)}`
      : `Download missing models: ${tagList(missing)}`;
  return {
    text: `Download ${plural(missing, 'model')}`,
    label: size === undefined ? label : `${label} (${size.parenthetical})`,
    sizeText: size === undefined ? '' : size.sentence,
  };
}

/**
 * The stated size in both the forms the UI needs — "about 8.6 GB" when every
 * tag's size is declared, "more than 5.3 GB" when one is not — or `undefined`
 * when no tag declares one, the repo's way of saying absent (`themedScreenRoot`).
 *
 * An undeclared tag is never counted as zero: understating the download is the
 * failure this sentence exists to fix, so a partial total is reported as a floor
 * and a total with nothing behind it is not reported at all.
 */
function sizePhrase(
  missing: readonly ModelHealth[],
  sizes: Readonly<Record<string, number>>,
): { parenthetical: string; sentence: string } | undefined {
  let gb = 0;
  let complete = true;
  for (const { tag } of missing) {
    const size = sizes[tag];
    if (size === undefined) complete = false;
    else gb += size;
  }
  if (gb <= 0) return undefined;
  const total = `${gb.toFixed(1)} GB`;
  return complete
    ? { parenthetical: `about ${total}`, sentence: `About ${total} to download` }
    : { parenthetical: `more than ${total}`, sentence: `More than ${total} to download` };
}

const tagList = (missing: readonly ModelHealth[]): string => missing.map((m) => m.tag).join(', ');
const plural = (missing: readonly ModelHealth[], noun: string): string =>
  missing.length === 1 ? noun : `${noun}s`;

// ── One progress bar across the whole required set ──────────────────────────

/**
 * An in-flight first-run pull, aggregated across every model it covers.
 *
 * Held in the renderer's screen state, never in the DOM: the renderer replaces
 * its whole DOM subtree on every render, and a download reports progress many
 * times per second, so anything kept in the DOM would be destroyed by the next
 * frame it triggered.
 */
export interface ModelPullState {
  /** Tags the download was expected to cover when it started. */
  readonly expected: readonly string[];
  /** Tags that have reported at least once, in the order they started. */
  readonly seen: readonly string[];
  /** Tags whose transfer has finished. */
  readonly finished: readonly string[];
  /** Aggregate completion [0..100], monotonically non-decreasing. */
  readonly percent: number;
  /** Status line naming the model currently transferring. */
  readonly text: string;
}

/** The state of a download that has been started but has not yet reported. */
export function startModelPull(expected: readonly string[]): ModelPullState {
  return { expected: [...expected], seen: [], finished: [], percent: 0, text: 'Starting download…' };
}

/**
 * Fold one progress line into the aggregate.
 *
 * Overall completion is the count of finished models plus the fraction of the
 * one currently transferring, over the total — so the bar advances across the
 * set instead of resetting to zero when the second model starts, which after a
 * single stated size reads as a failure and a restart rather than as progress.
 *
 * Two independent guards keep it from going backwards, because two different
 * things move it: the arithmetic above (a model finishing never subtracts), and
 * a `Math.max` against the previous value (Ollama reports bytes for the LAYER in
 * flight, so `percent` legitimately drops to near-zero inside one model, and an
 * unforeseen tag can widen the denominator mid-download).
 *
 * KNOWN BOUND of that second guard: because `percent` is per-layer, a small
 * layer completing pins the bar at that model's full share until the model
 * genuinely finishes — the bar can run ahead and then sit still. Monotonicity is
 * the property the screen is specified on (a reset reads as a restart), and it
 * is bought at the cost of precision within a model. The status line, which
 * carries the live per-layer percent and the model's name, is what keeps moving
 * meanwhile. Byte-accurate progress would need a per-model total the pull
 * transport does not report.
 *
 * The progress payload's existing `model` field is what identifies the transfer
 * — added for the document-model pull and reused here rather than duplicated.
 * An unnamed line continues whichever model last reported.
 */
export function advanceModelPull(prev: ModelPullState, p: ModelPullProgress): ModelPullState {
  const tag = p.model ?? prev.seen[prev.seen.length - 1] ?? '';
  const seen = prev.seen.includes(tag) ? prev.seen : [...prev.seen, tag];
  // A model that starts reporting implies every model before it in the sequence
  // is done — the runtime pulls in sequence, and a `success` line can be missed.
  const finished = [...prev.finished];
  for (const earlier of seen.slice(0, seen.indexOf(tag))) {
    if (!finished.includes(earlier)) finished.push(earlier);
  }
  if (p.status === 'success' && !finished.includes(tag)) finished.push(tag);

  const total = Math.max(prev.expected.length, seen.length, 1);
  const current = finished.includes(tag) ? 0 : fraction(p.percent);
  const raw = ((finished.length + current) / total) * 100;
  const percent = Math.max(prev.percent, Math.min(100, Math.round(raw)));
  const done = finished.length >= total;

  return {
    expected: prev.expected,
    seen,
    finished,
    percent,
    text: pullText(p, tag, seen, total, done),
  };
}

const fraction = (percent: number | undefined): number =>
  typeof percent === 'number' && Number.isFinite(percent) ? Math.min(1, Math.max(0, percent / 100)) : 0;

/**
 * The status line: what the runtime is doing, to WHICH model, and where that
 * model sits in the set. Naming the model is what keeps a long pause on a large
 * file from reading as a hang — and it is also the line that keeps moving while
 * the aggregate bar sits still on a big layer.
 *
 * `success` is a per-MODEL line, not the end of the pull, so it reads as
 * "Downloaded <tag>" until the last one — where it becomes the same "Finishing…"
 * the document-model pull shows, rather than a raw transport verb.
 */
function pullText(
  p: ModelPullProgress,
  tag: string,
  seen: readonly string[],
  total: number,
  done: boolean,
): string {
  const position = total > 1 ? ` (model ${seen.indexOf(tag) + 1} of ${total})` : '';
  if (p.status === 'success') {
    return done ? 'Finishing…' : `Downloaded ${tag}${position}`;
  }
  const head = tag === '' ? p.status : `${p.status} ${tag}`;
  const pct = typeof p.percent === 'number' ? ` ${Math.round(p.percent)}%` : '';
  return `${head}${pct}${position}`;
}

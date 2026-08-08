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
import type { ModelHealth, RuntimeHealth } from '../../contracts/index.js';

/**
 * The required models the runtime reports as missing — in role order (text
 * first), deduplicated by tag.
 *
 * Deduplication is the point at today's defaults, where `vision` inherits the
 * text tag: two required roles, but ONE download to offer and one tag to name.
 * A required model the runtime does not report at all is NOT counted as missing;
 * absent means "cannot report", which the caller already sees as an unreachable
 * sidecar.
 */
export function missingRequiredModels(health: Pick<RuntimeHealth, 'model' | 'visionModel'>): ModelHealth[] {
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
 * The download affordance's visible text and its accessible name. Both come from
 * here so they cannot disagree about how many models the button is about — the
 * button says "Download models" only when the label lists more than one.
 */
export function downloadModelAffordance(missing: readonly ModelHealth[]): { text: string; label: string } {
  return {
    text: `Download ${plural(missing, 'model')}`,
    label:
      missing.length === 1
        ? `Download model ${tagList(missing)}`
        : `Download missing models: ${tagList(missing)}`,
  };
}

const tagList = (missing: readonly ModelHealth[]): string => missing.map((m) => m.tag).join(', ');
const plural = (missing: readonly ModelHealth[], noun: string): string =>
  missing.length === 1 ? noun : `${noun}s`;

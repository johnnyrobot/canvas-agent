/**
 * Knowledge-Pack prompt grounding (PRD §13.1, §15.2).
 *
 * The orchestrator's hard-rule system prompt is the model's behavioural contract;
 * grounding *prepends* the top retrieved citations above it so the model answers
 * from the Knowledge Packs (and can cite them) without ever loosening the rules.
 * Pure and dependency-free so it is trivially unit-testable offline.
 */
import type { KbResult } from '../contracts/index.js';

export interface GroundingOptions {
  /** Maximum citations to inject. Default 3. */
  maxCitations?: number;
}

/** Default number of top citations prepended to the system prompt. */
export const DEFAULT_MAX_CITATIONS = 3;

/**
 * Prepend the top `kb` citations to `base` (the hard rules). The base prompt is
 * never modified — citations are added ABOVE it, so the rules always have the
 * last word. With no hits the base is returned unchanged; with neither, `''`.
 */
export function groundSystemPrompt(
  base: string | undefined,
  kb: KbResult,
  opts: GroundingOptions = {},
): string {
  const max = opts.maxCitations ?? DEFAULT_MAX_CITATIONS;
  const hits = kb.hits.slice(0, Math.max(0, max));
  if (hits.length === 0) return base ?? '';

  const lines = hits.map((h) => `- ${h.citation}: ${h.snippet}`);
  const block =
    'Ground your answer in the following sources from the active Knowledge Packs, ' +
    'and cite the relevant reference label when you rely on one:\n' +
    lines.join('\n');

  return base && base.length > 0 ? `${block}\n\n${base}` : block;
}

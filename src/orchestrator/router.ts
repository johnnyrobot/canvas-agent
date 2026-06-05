/**
 * Intent router (PRD product layer): classify a user turn into a `ProductMode`
 * when the caller has not explicitly picked one.
 *
 * Pure, deterministic, and I/O-free so it is trivially unit-testable offline and
 * gives identical answers every run. An explicit `override` always wins; without
 * one we classify by cheap lexical signals:
 *   1. pasted/substantial HTML *or* remediation vocabulary ⇒ `remediate`
 *   2. authoring/build vocabulary                          ⇒ `build`
 *   3. otherwise                                           ⇒ `guidance` (default)
 */
import type { ProductMode } from '../contracts/index.js';

export interface IntentDecision {
  mode: ProductMode;
  /** A simple 0..1 heuristic; 1 only for an explicit override. */
  confidence: number;
  reason: string;
}

/** HTML tag fragments that mark a pasted Canvas page worth remediating. */
const HTML_SIGNALS = [
  '<p',
  '<div',
  '<table',
  '<img',
  '<h1',
  '<h2',
  '<h3',
  '<h4',
  '<h5',
  '<h6',
  '<ul',
  '<a ',
] as const;

/** Vocabulary that signals "repair the accessibility of this content". */
const REMEDIATION_WORDS = [
  'fix',
  'accessib',
  'contrast',
  'alt text',
  'wcag',
  'remediate',
  'repair',
  'broken',
] as const;

/** Vocabulary that signals "author/produce a new Canvas artifact". */
const BUILD_WORDS = [
  'create',
  'make',
  'build',
  'generate',
  'draft',
  'template',
  'page',
  'module',
  'syllabus',
  'quiz',
  'rubric',
  'assignment',
] as const;

/**
 * More matched signals ⇒ higher confidence, capped below an explicit override's
 * 1.0. Kept intentionally simple — the router is a heuristic, not a classifier.
 */
function confidenceFor(hits: number): number {
  return Math.min(0.95, 0.6 + 0.1 * hits);
}

function countHits(haystack: string, needles: readonly string[]): number {
  return needles.reduce((n, needle) => (haystack.includes(needle) ? n + 1 : n), 0);
}

/**
 * Decide the product mode for a turn. `override` (an explicit user mode pick)
 * always wins. Otherwise classify by lexical signal; ambiguous input falls back
 * to `guidance`.
 */
export function routeIntent(user: string, override?: ProductMode): IntentDecision {
  if (override) return { mode: override, confidence: 1, reason: 'explicit override' };

  const text = user.toLowerCase();

  const htmlHits = countHits(text, HTML_SIGNALS);
  const remediationHits = countHits(text, REMEDIATION_WORDS);
  if (htmlHits > 0 || remediationHits > 0) {
    return {
      mode: 'remediate',
      confidence: confidenceFor(htmlHits + remediationHits),
      reason: htmlHits > 0 ? 'detected pasted HTML to repair' : 'detected remediation keywords',
    };
  }

  const buildHits = countHits(text, BUILD_WORDS);
  if (buildHits > 0) {
    return { mode: 'build', confidence: confidenceFor(buildHits), reason: 'detected authoring keywords' };
  }

  return { mode: 'guidance', confidence: 0.5, reason: 'no build or remediation signal; defaulting to guidance' };
}

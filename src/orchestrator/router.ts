/**
 * Intent router (PRD product layer): classify a user turn into a `ProductMode`
 * when the caller has not explicitly picked one.
 *
 * Pure, deterministic, and I/O-free so it is trivially unit-testable offline and
 * gives identical answers every run. An explicit `override` always wins; without
 * one we classify by cheap lexical signals, in priority order:
 *   1. pasted/substantial HTML                 ⇒ `remediate` (concrete content to fix)
 *   2. STRONG repair vocabulary                ⇒ `remediate` (beats authoring verbs)
 *   3. authoring/build vocabulary              ⇒ `build`     (beats weak a11y words)
 *   4. WEAK a11y vocabulary (accessible, …)    ⇒ `remediate`
 *   5. otherwise                               ⇒ `guidance`  (default)
 *
 * The strong/weak split matters: "create an *accessible* page" is a BUILD, while
 * "fix the contrast on this" is a remediation.
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

/**
 * STRONG repair intent — explicit "fix existing content" verbs/terms. These beat
 * authoring verbs (e.g. "fix this page I want to create" ⇒ remediate).
 */
const REMEDIATION_STRONG = ['fix', 'alt text', 'wcag', 'remediate', 'repair', 'broken'] as const;

/**
 * WEAK accessibility vocabulary — present in BOTH authoring and repair requests
 * (e.g. "create an *accessible* page" is a BUILD, not a remediation). Only
 * decisive when no authoring verb is present, so build wins the overlap.
 */
const REMEDIATION_WEAK = ['accessib', 'contrast'] as const;

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

  // 1. Pasted/substantial HTML ⇒ concrete content to repair.
  const htmlHits = countHits(text, HTML_SIGNALS);
  if (htmlHits > 0) {
    return { mode: 'remediate', confidence: confidenceFor(htmlHits), reason: 'detected pasted HTML to repair' };
  }

  // 2. Strong repair intent beats authoring verbs ("fix this page I'll create").
  const strongHits = countHits(text, REMEDIATION_STRONG);
  if (strongHits > 0) {
    return { mode: 'remediate', confidence: confidenceFor(strongHits), reason: 'detected remediation keywords' };
  }

  // 3. Authoring verbs ⇒ build (wins over weak a11y words like "accessible").
  const buildHits = countHits(text, BUILD_WORDS);
  if (buildHits > 0) {
    return { mode: 'build', confidence: confidenceFor(buildHits), reason: 'detected authoring keywords' };
  }

  // 4. Only weak a11y vocabulary, no authoring verb ⇒ remediate.
  const weakHits = countHits(text, REMEDIATION_WEAK);
  if (weakHits > 0) {
    return { mode: 'remediate', confidence: confidenceFor(weakHits), reason: 'detected accessibility keywords' };
  }

  return { mode: 'guidance', confidence: 0.5, reason: 'no build or remediation signal; defaulting to guidance' };
}

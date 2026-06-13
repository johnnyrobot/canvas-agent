/**
 * Intent router (PRD product layer): classify a user turn into a `ProductMode`
 * when the caller has not explicitly picked one.
 *
 * Pure, deterministic, and I/O-free so it is trivially unit-testable offline and
 * gives identical answers every run. An explicit `override` always wins; without
 * one we classify by cheap lexical signals, in priority order:
 *   1. pasted/substantial HTML                 ⇒ `remediate` (concrete content to fix)
 *   2. STRONG repair vocabulary                ⇒ `remediate` (beats authoring verbs)
 *   3. authoring VERBS (create, make, …)       ⇒ `build`     (beat weak a11y words)
 *   4. WEAK a11y vocabulary (accessible, …)    ⇒ `remediate` (beats a lone artifact noun)
 *   5. a bare artifact NOUN (page, syllabus…)  ⇒ `build`
 *   6. otherwise                               ⇒ `guidance`  (default)
 *
 * Natural-language vocabulary is matched at a leading WORD BOUNDARY (so "fix" is a
 * repair word but "prefix"/"suffix" are not); HTML tag fragments are substring-matched.
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

/** Authoring VERBS — an explicit intent to produce a new artifact; these beat weak a11y words. */
const BUILD_VERBS = ['create', 'make', 'build', 'generate', 'draft', 'template'] as const;

/**
 * Artifact NOUNS. A bare noun ("my syllabus") defaults to build, but ONLY after weak
 * a11y vocabulary has had its say — otherwise "is my syllabus accessible" (an audit)
 * would mis-route to build just because it names an artifact.
 */
const BUILD_NOUNS = ['page', 'module', 'syllabus', 'quiz', 'rubric', 'assignment'] as const;

/**
 * More matched signals ⇒ higher confidence, capped below an explicit override's
 * 1.0. Kept intentionally simple — the router is a heuristic, not a classifier.
 */
function confidenceFor(hits: number): number {
  return Math.min(0.95, 0.6 + 0.1 * hits);
}

/** Substring match — used for HTML tag fragments, where a leading `\b` before `<` would fail. */
function countHits(haystack: string, needles: readonly string[]): number {
  return needles.reduce((n, needle) => (haystack.includes(needle) ? n + 1 : n), 0);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Count needles that occur at a leading WORD BOUNDARY — for natural-language
 * vocabulary, NOT HTML. So "fix" matches "fix"/"fixes"/"fixed" but not the affix
 * inside "prefixes"/"suffixes"; "accessib" still matches "accessible"/"accessibility";
 * "contrast" still matches "high-contrast" (the hyphen is a boundary).
 */
function countStemHits(haystack: string, needles: readonly string[]): number {
  return needles.reduce((n, needle) => (new RegExp(`\\b${escapeRe(needle)}`).test(haystack) ? n + 1 : n), 0);
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
  const strongHits = countStemHits(text, REMEDIATION_STRONG);
  if (strongHits > 0) {
    return { mode: 'remediate', confidence: confidenceFor(strongHits), reason: 'detected remediation keywords' };
  }

  // 3. Authoring VERBS ⇒ build (wins over weak a11y words like "accessible").
  const verbHits = countStemHits(text, BUILD_VERBS);
  if (verbHits > 0) {
    return { mode: 'build', confidence: confidenceFor(verbHits), reason: 'detected authoring keywords' };
  }

  // 4. Weak a11y vocabulary, no authoring verb ⇒ remediate (beats a lone artifact noun).
  const weakHits = countStemHits(text, REMEDIATION_WEAK);
  if (weakHits > 0) {
    return { mode: 'remediate', confidence: confidenceFor(weakHits), reason: 'detected accessibility keywords' };
  }

  // 5. A bare artifact noun (no verb, no a11y word) ⇒ build (default authoring intent).
  const nounHits = countStemHits(text, BUILD_NOUNS);
  if (nounHits > 0) {
    return { mode: 'build', confidence: confidenceFor(nounHits), reason: 'detected authoring keywords' };
  }

  return { mode: 'guidance', confidence: 0.5, reason: 'no build or remediation signal; defaulting to guidance' };
}

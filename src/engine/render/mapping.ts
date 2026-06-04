/**
 * Pure axe → IssueSet mapping tables (PRD §8.5, Appendix K).
 *
 * Two independent axes of classification:
 *   - SEVERITY comes from axe `impact` (FROZEN by the track brief / Appendix K):
 *       critical→blocker, serious→error, moderate→warning, minor→advisory.
 *     Incomplete (needs-review) results are always `alert`, regardless of impact.
 *   - CATEGORY is the WAVE six-category reporting vocabulary (Appendix K.1). It is
 *     derived from the rule id and is orthogonal to severity.
 *
 * No DOM, no network, no dependencies — all of this is exercised by `mapping.test.ts`.
 */
import type { AuditIssue, Severity } from '../../contracts/index.js';
import type { AxeImpact } from './types.js';

/** The non-undefined WAVE categories an `AuditIssue` can carry. */
export type IssueCategory = NonNullable<AuditIssue['category']>;

/** axe impact → Severity. FROZEN: do not reorder or remap (AGENT_BRIEF / Appendix K). */
const IMPACT_SEVERITY: Readonly<Record<AxeImpact, Severity>> = {
  critical: 'blocker',
  serious: 'error',
  moderate: 'warning',
  minor: 'advisory',
};

/**
 * Severity for a violation whose `impact` axe left null/absent. A violation is a
 * *definite* failure, so we never downgrade it below `error`, but absent a
 * critical impact we don't auto-block on it either. (Documented assumption: the
 * frozen table only covers the four named impacts.)
 */
export const DEFAULT_VIOLATION_SEVERITY: Severity = 'error';

export function severityForImpact(impact: AxeImpact | null | undefined): Severity {
  return impact ? IMPACT_SEVERITY[impact] : DEFAULT_VIOLATION_SEVERITY;
}

/** Contrast rules (computed-color failures → the WAVE Contrast category). */
const CONTRAST_RULES: ReadonlySet<string> = new Set(['color-contrast', 'color-contrast-enhanced']);

/**
 * Structural / semantic rules → the WAVE Structure category (headings, lists,
 * landmarks/regions, data-table structure). Per AGENT_BRIEF: heading-order and
 * landmark rules map to `structure`.
 */
const STRUCTURE_RULES: ReadonlySet<string> = new Set([
  'heading-order',
  'p-as-heading',
  'list',
  'listitem',
  'definition-list',
  'dlitem',
  'region',
  'bypass',
  'landmark-one-main',
  'landmark-unique',
  'landmark-banner-is-top-level',
  'landmark-complementary-is-top-level',
  'landmark-contentinfo-is-top-level',
  'landmark-main-is-top-level',
  'landmark-no-duplicate-banner',
  'landmark-no-duplicate-contentinfo',
  'landmark-no-duplicate-main',
  'td-headers-attr',
  'th-has-data-cells',
  'td-has-header',
  'scope-attr-valid',
  'table-duplicate-name',
  'table-fake-caption',
]);

/**
 * The semantic WAVE category for an axe rule id, or `undefined` when the rule has
 * no dedicated category (callers default these to `error` for violations and to
 * `alert` for needs-review/incomplete results).
 *
 * Mapping (AGENT_BRIEF + Appendix K):
 *   - `color-contrast*`           → contrast
 *   - `aria-*`                    → aria
 *   - heading/landmark/list/table → structure
 *   - everything else            → undefined (e.g. image-alt, label, link-name…)
 */
export function semanticCategory(id: string): IssueCategory | undefined {
  if (CONTRAST_RULES.has(id) || id.includes('color-contrast')) return 'contrast';
  if (id.startsWith('aria-')) return 'aria';
  if (STRUCTURE_RULES.has(id)) return 'structure';
  return undefined;
}

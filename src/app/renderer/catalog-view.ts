/**
 * Pure view logic for the "Official course outcomes" catalog-enrichment panel
 * (optional; degrades to absent when the catalog CLI isn't installed — see
 * `src/catalog/README.md` and `CatalogCourseSummary`/`CatalogCourse` in
 * `src/contracts/index.ts`).
 *
 * Kept dependency-free (no `El`, no `document`/`window`) so it's unit-testable
 * without a DOM, mirroring `ui-theme.ts`. `renderer.ts` owns the catalog state
 * (search query, results, selection) and calls into this module to decide (a)
 * how to label a search-result row and (b) what prompt lines a selected
 * course contributes to the generated-page prompt.
 */
import type { CatalogCourse, CatalogCourseSummary } from '../../contracts/index.js';

/**
 * Label for a catalog search-result row, e.g.
 * "ACCTG001 — Introductory Accounting I (wlac.elumenapp.com)". The college
 * parenthetical is omitted when the summary has no `college`.
 */
export function catalogSummaryLabel(summary: CatalogCourseSummary): string {
  const base = `${summary.code} — ${summary.title}`;
  return summary.college ? `${base} (${summary.college})` : base;
}

/**
 * Prompt lines contributed by a selected catalog course — [] when no course is
 * selected. Grounds the generated page in the official LACCD catalog's SLOs
 * (falling back to an explicit "no outcomes on file" marker rather than
 * silently omitting the section) and, when present, the course description.
 */
export function catalogPromptLines(course: CatalogCourse | undefined): string[] {
  if (!course) return [];
  const lines = [
    `Official course outcomes (LACCD catalog, ${course.code}):`,
    ...(course.slos.length > 0 ? course.slos.map((slo) => `- ${slo}`) : ['- [no outcomes on file]']),
  ];
  if (course.description) lines.push(`Official course description: ${course.description}`);
  return lines;
}

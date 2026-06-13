/**
 * `createAuditor` — the pure render-and-scan mapping core (PRD §8, Appendix K).
 *
 * Given an injected `ScanRunner` (real Chromium in production, a fake in tests),
 * this turns one scan pass into an `IssueSet`:
 *   1. axe violations    → impact-driven severity + WAVE category.
 *   2. axe incompletes   → `alert` (needs human review).
 *   3. computed contrast → pure `runContrastIssue` adjudicator on each TextRun;
 *      solid/gradient failures block; image worst-case warns; unresolvable alerts.
 *
 * All scanning is behind the runner, so this module — and the bulk of the tests —
 * is fully offline and browser-free.
 */
import type { AuditIssue, Auditor, IssueSet, Severity } from '../../contracts/index.js';
import type { AxeResult, ScanRunner } from './types.js';
import { semanticCategory, severityForImpact } from './mapping.js';
import { runContrastIssue } from './run-contrast.js';

export interface AuditorOptions {
  /** Severity for deterministic contrast failures (solid/gradient). Default 'blocker'. */
  contrastFailSeverity?: Severity;
  /** Severity for raster (background-image) worst-case estimate failures. Default 'warning'. */
  imageContrastSeverity?: Severity;
  /** Interpolated samples per adjacent gradient stop pair (≈ every 10%). Default 9. */
  gradientSamples?: number;
}

function messageFor(result: AxeResult): string {
  return result.description ?? result.help ?? result.id;
}

export function createAuditor(runner: ScanRunner, options: AuditorOptions = {}): Auditor {
  const failSeverity = options.contrastFailSeverity ?? 'blocker';
  const imageFailSeverity = options.imageContrastSeverity ?? 'warning';
  const gradientSamples = options.gradientSamples ?? 9;

  return async function audit(html: string): Promise<IssueSet> {
    const { axe, textRuns } = await runner.run(html);
    const issues: AuditIssue[] = [];

    // [1] axe violations — impact-driven severity, rule-driven category.
    for (const v of axe.violations) {
      issues.push({
        id: v.id,
        severity: severityForImpact(v.impact),
        message: messageFor(v),
        category: semanticCategory(v.id) ?? 'error',
      });
    }

    // [2] axe incomplete / needs-review — always alert; keep semantic category if any.
    for (const inc of axe.incomplete ?? []) {
      issues.push({
        id: inc.id,
        severity: 'alert',
        message: messageFor(inc),
        category: semanticCategory(inc.id) ?? 'alert',
      });
    }

    // [3] computed-contrast pass (§8.3) — adjudicates solid/gradient/image/unresolvable.
    for (const run of textRuns) {
      const issue = runContrastIssue(run, { failSeverity, imageFailSeverity, gradientSamples });
      if (issue) issues.push(issue);
    }

    return { issues };
  };
}

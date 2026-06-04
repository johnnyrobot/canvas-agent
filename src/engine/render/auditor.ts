/**
 * `createAuditor` — the pure render-and-scan mapping core (PRD §8, Appendix K).
 *
 * Given an injected `ScanRunner` (real Chromium in production, a fake in tests),
 * this turns one scan pass into an `IssueSet`:
 *   1. axe violations    → impact-driven severity + WAVE category.
 *   2. axe incompletes   → `alert` (needs human review).
 *   3. computed contrast → engine-core `checkContrast` on each text pair; AA
 *      failures become blocking contrast issues; uncomputable pairs (gradients,
 *      transparency, …) become needs-review alerts rather than silent passes.
 *
 * All scanning is behind the runner, so this module — and the bulk of the tests —
 * is fully offline and browser-free.
 */
import { checkContrast } from '../index.js';
import { WCAG } from '../../contracts/index.js';
import type { AuditIssue, Auditor, IssueSet, Severity } from '../../contracts/index.js';
import type { AxeResult, ScanRunner, TextColorPair } from './types.js';
import { semanticCategory, severityForImpact } from './mapping.js';

export interface AuditorOptions {
  /**
   * Severity assigned to a computed-contrast pair that fails WCAG AA. Defaults to
   * `'blocker'` because Appendix K.1 classifies a Contrast Error as badge-
   * withholding. Set to `'error'` for a non-blocking treatment.
   */
  contrastFailSeverity?: Severity;
}

/** Stable id for findings from the computed-contrast pass (WAVE `contrast`). */
const CONTRAST_ID = 'contrast';

function messageFor(result: AxeResult): string {
  return result.description ?? result.help ?? result.id;
}

function contrastIssue(pair: TextColorPair, failSeverity: Severity): AuditIssue | null {
  let result;
  try {
    result = checkContrast(pair.fg, pair.bg, pair.size);
  } catch {
    // Gradient / transparency / unparseable color → cannot adjudicate. Route to
    // needs-manual-review (Appendix K.5) rather than passing it silently.
    return {
      id: CONTRAST_ID,
      severity: 'alert',
      message: `Contrast for ${pair.fg} on ${pair.bg} could not be computed; manual review needed.`,
      category: 'contrast',
    };
  }
  if (result.passesAA) return null;
  const min = pair.size === 'large' ? WCAG.AA_LARGE : WCAG.AA_NORMAL;
  return {
    id: CONTRAST_ID,
    severity: failSeverity,
    message: `Text contrast ${result.ratio}:1 is below the WCAG AA minimum of ${min}:1 for ${pair.size} text (${pair.fg} on ${pair.bg}).`,
    category: 'contrast',
  };
}

/**
 * Build an `Auditor` from an injected scanner. Production wires the Chromium
 * `playwrightRunner`; tests wire a fake. The returned function is the frozen
 * `Auditor` port: `(html) => Promise<IssueSet>`.
 */
export function createAuditor(runner: ScanRunner, options: AuditorOptions = {}): Auditor {
  const contrastFailSeverity = options.contrastFailSeverity ?? 'blocker';

  return async function audit(html: string): Promise<IssueSet> {
    const { axe, textPairs } = await runner.run(html);
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

    // [3] computed-contrast pass (§8.3).
    for (const pair of textPairs) {
      const issue = contrastIssue(pair, contrastFailSeverity);
      if (issue) issues.push(issue);
    }

    return { issues };
  };
}

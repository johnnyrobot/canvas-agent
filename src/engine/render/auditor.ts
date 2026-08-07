/**
 * `createAuditor` — the pure render-and-scan mapping core (PRD §8, Appendix K).
 *
 * Given an injected `ScanRunner` (real Chromium in production, a fake in tests),
 * this turns one scan pass into an `IssueSet` by running every registered check
 * over it. The checks themselves — and the list of them — live in `checks.ts`
 * (ADR-0003); this module is now just "scan once, run the registry, collect".
 *
 * All scanning is behind the runner, so this module — and the bulk of the tests —
 * is fully offline and browser-free.
 */
import type { AuditIssue, Auditor, IssueSet, Severity } from '../../contracts/index.js';
import type { ScanRunner } from './types.js';
import { CHECKS, type Check, type CheckOptions } from './checks.js';

export interface AuditorOptions {
  /** Severity for deterministic contrast failures (solid/gradient). Default 'blocker'. */
  contrastFailSeverity?: Severity;
  /** Severity for raster (background-image) worst-case estimate failures. Default 'warning'. */
  imageContrastSeverity?: Severity;
  /** Interpolated samples per adjacent gradient stop pair (≈ every 10%). Default 9. */
  gradientSamples?: number;
  /**
   * The checks to run. Defaults to the full registry (`CHECKS`); override to
   * audit with a reduced or substituted set. Production passes nothing.
   */
  checks?: readonly Check[];
}

export function createAuditor(runner: ScanRunner, options: AuditorOptions = {}): Auditor {
  const checkOptions: CheckOptions = {
    failSeverity: options.contrastFailSeverity ?? 'blocker',
    imageFailSeverity: options.imageContrastSeverity ?? 'warning',
    gradientSamples: options.gradientSamples ?? 9,
  };
  const checks = options.checks ?? CHECKS;

  return async function audit(html: string): Promise<IssueSet> {
    const scan = await runner.run(html);
    // One scan, every registered check, in registration order. Each check gets
    // the WHOLE ScanResult, so adding one means editing the registry in
    // `checks.ts` — this loop never changes (ADR-0003).
    const issues: AuditIssue[] = checks.flatMap((check) => check(scan, checkOptions));
    return { issues };
  };
}

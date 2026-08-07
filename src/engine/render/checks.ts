/**
 * The accessibility check registry (ADR-0003).
 *
 * Adding a deterministic check used to mean editing seven files, because
 * `auditor.ts` hardcoded one numbered pass per rule. Checks are registered
 * HERE, in one list, and the auditor iterates it.
 *
 * Two rules make that cheap:
 *
 *  1. **A check receives the whole `ScanResult`.** No per-check declaration of
 *     which page data it wants, and no plumbing to add when it wants more —
 *     that machinery was rejected as sized for a rule count that doesn't exist.
 *  2. **Fields added to `ScanResult` for a new check are OPTIONAL.** That is
 *     what keeps every existing check and every fake fixture compiling when the
 *     next check needs data nobody collects yet. The rule is applied
 *     retroactively: `ScanResult.images` is optional too, rather than being
 *     grandfathered in as the one permanent exception.
 *
 * What a registry does NOT remove: the browser-side extraction script, when a
 * check needs page data the runner doesn't gather yet. The win is roughly four
 * of the seven files, not seven.
 */
import type { AuditIssue } from '../../contracts/index.js';
import type { ScanResult } from './types.js';
import { semanticCategory, severityForImpact } from './mapping.js';
import { runContrastIssue, type RunContrastOptions } from './run-contrast.js';
import { altTextIssue } from './alt-text.js';
import type { AxeResult } from './types.js';

/**
 * The resolved knobs every check is handed (see `AuditorOptions`). Today only
 * `computedContrast` reads any of them, so this is exactly the contrast options
 * under the name the registry uses — an alias, not a seam pretending to be one.
 */
export type CheckOptions = RunContrastOptions;

/**
 * One accessibility check: whole scan in, issues out. Pure and synchronous —
 * all the I/O already happened in the `ScanRunner`.
 */
export type Check = (scan: ScanResult, options: CheckOptions) => AuditIssue[];

function messageFor(result: AxeResult): string {
  return result.description ?? result.help ?? result.id;
}

/** axe violations — impact-driven severity, rule-driven category. */
export const axeViolations: Check = (scan) =>
  scan.axe.violations.map((v) => ({
    id: v.id,
    severity: severityForImpact(v.impact),
    message: messageFor(v),
    category: semanticCategory(v.id) ?? 'error',
  }));

/** axe incomplete / needs-review — always alert; keep the semantic category if any. */
export const axeIncomplete: Check = (scan) =>
  (scan.axe.incomplete ?? []).map((inc) => ({
    id: inc.id,
    severity: 'alert' as const,
    message: messageFor(inc),
    category: semanticCategory(inc.id) ?? 'alert',
  }));

/** Computed-contrast pass (§8.3) — adjudicates solid / gradient / image / unresolvable. */
export const computedContrast: Check = (scan, options) =>
  scan.textRuns.flatMap((run) => {
    const issue = runContrastIssue(run, options);
    return issue ? [issue] : [];
  });

/**
 * Alt-text QUALITY pass. axe only checks that `alt` exists; this judges whether
 * it says anything (filenames, placeholders, URLs). It is also what verifies
 * model-drafted alt from `describe_image` — the gate re-audits, so a junk draft
 * is caught by a rule rather than trusted.
 */
export const altTextQuality: Check = (scan) =>
  (scan.images ?? []).flatMap((image) => {
    const issue = altTextIssue(image);
    return issue ? [issue] : [];
  });

/**
 * THE REGISTRY. Add a check by adding it here.
 *
 * Order is the order issues are reported in, and is kept as the numbered passes
 * had it: axe violations, axe incompletes, computed contrast, alt-text quality.
 */
export const CHECKS: readonly Check[] = [axeViolations, axeIncomplete, computedContrast, altTextQuality];

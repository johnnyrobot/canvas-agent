/**
 * The unconditional, server-side output gate (PRD §8.6 / §15.3 / §15.7).
 *
 * Every fragment of HTML the app would show passes through here regardless of
 * what the model did: it is allowlist-gated (Canvas-safe) and re-audited, and a
 * residual blocker WITHHOLDS the "passed checks" badge (`A11Y_FAIL_OPEN=false`).
 * The model is never trusted to self-certify.
 *
 * The deterministic engine doesn't exist yet, so the gate takes its two
 * deterministic steps as injected dependencies. The gate's own logic (badge
 * withholding) is real and unit-tested with mocks.
 */

export type Severity = 'blocker' | 'error' | 'warning' | 'advisory' | 'alert';

export interface AuditIssue {
  id: string;
  severity: Severity;
  message: string;
  /** WAVE category for reporting (PRD §8.5). */
  category?: 'error' | 'contrast' | 'alert' | 'feature' | 'structure' | 'aria';
}

export interface IssueSet {
  issues: AuditIssue[];
}

export interface AllowlistResult {
  /** Repaired, Canvas-safe HTML. */
  html: string;
  /** Semantic elements that had to be removed (not merely decorative) — these block. */
  removedSemantic: string[];
}

export interface GateDeps {
  /** Deterministic Canvas allowlist gate (PRD Appendix B). */
  validateAllowlist(html: string): Promise<AllowlistResult>;
  /** Deterministic render-and-scan audit (PRD §8). */
  audit(html: string): Promise<IssueSet>;
}

export interface Conformance {
  /** True only if no blocker survived. */
  passedChecks: boolean;
  blockers: AuditIssue[];
  warnings: AuditIssue[];
  /** Items requiring human review (alerts + manual-only). */
  needsHumanReview: AuditIssue[];
}

export interface GateResult {
  /** Allowlist-gated HTML — safe to show / copy. */
  html: string;
  conformance: Conformance;
  /** When true, do NOT show a "passed checks" badge; surface the blockers. */
  badgeWithheld: boolean;
}

/** Severities that withhold the conformant badge (cf. `A11Y_GATE_BLOCK_SEVERITIES`). */
const BLOCKING: ReadonlySet<Severity> = new Set<Severity>(['blocker']);

export async function enforceGate(html: string, deps: GateDeps): Promise<GateResult> {
  const allow = await deps.validateAllowlist(html);
  const { issues } = await deps.audit(allow.html);

  const blockers = issues.filter((i) => BLOCKING.has(i.severity));
  // Removing a *semantic* element during allowlist repair is itself a blocker.
  for (const tag of allow.removedSemantic) {
    blockers.push({ id: 'allowlist-removed-semantic', severity: 'blocker', message: `Removed semantic <${tag}>` });
  }
  const warnings = issues.filter((i) => i.severity === 'warning' || i.severity === 'error');
  const needsHumanReview = issues.filter((i) => i.severity === 'alert' || i.severity === 'advisory');

  const badgeWithheld = blockers.length > 0;
  return {
    html: allow.html,
    conformance: { passedChecks: !badgeWithheld, blockers, warnings, needsHumanReview },
    badgeWithheld,
  };
}

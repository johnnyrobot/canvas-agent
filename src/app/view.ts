/**
 * PURE view-model mapping for the renderer.
 *
 * `turnViewToVm` turns a `TurnView` (the gated runtime output) into a flat,
 * render-ready `TurnVm`. The renderer (`renderer/*.ts`) does only DOM work on top
 * of this — all the decision logic (which badge, which messages to surface, the
 * resolved mode, the remediate before→after diff) lives here so it can be
 * unit-tested without a DOM.
 *
 * The badge is derived from the gate, never from the model: a fragment shows the
 * "passed" badge ONLY when the gate both passed its checks AND did not withhold
 * the badge (`A11Y_FAIL_OPEN=false`). Any blocker withholds it and the blocker
 * messages are surfaced instead.
 */
import type { ProductMode, TurnView } from '../contracts/index.js';

export type BadgeKind = 'passed' | 'withheld';

export interface BadgeVm {
  kind: BadgeKind;
  label: string;
}

/** One audited issue's before→after resolution, flattened for rendering. */
export interface IssueDiffVm {
  message: string;
  fixed: boolean;
}

/** Flattened remediate output: the source (`before`) and gated `after` + diff. */
export interface RemediateVm {
  /** The original HTML (UNGATED — render as text only, never via innerHTML). */
  before: string;
  /** The gated, safe-to-render repaired HTML. */
  after: string;
  issueDiffs: IssueDiffVm[];
}

export interface FragmentVm {
  /** Gate-approved, safe-to-render HTML (already through `enforceGate`). */
  html: string;
  /** True only when the accessibility badge may be shown. */
  passed: boolean;
  badge: BadgeVm;
  /** Blocker messages to surface when the badge is withheld. */
  blockers: string[];
  /** Items flagged for human review (alerts / advisories). */
  needsReview: string[];
  /** Present only for remediate-mode fragments: the before→after resolution. */
  remediateResult?: RemediateVm;
}

export interface TurnVm {
  text: string;
  toolsUsed: string[];
  iterations: number;
  fragments: FragmentVm[];
  /** The mode the router/override resolved to for this turn (when known). */
  mode?: ProductMode;
}

const PASSED_LABEL = 'Accessibility checks passed';
const WITHHELD_LABEL = 'Accessibility checks withheld';

export function turnViewToVm(view: TurnView): TurnVm {
  const vm: TurnVm = {
    text: view.text,
    toolsUsed: view.toolsUsed,
    iterations: view.iterations,
    fragments: view.fragments.map((fragment) => {
      const { gate } = fragment;
      const passed = gate.conformance.passedChecks && !gate.badgeWithheld;
      const fragmentVm: FragmentVm = {
        html: gate.html,
        passed,
        badge: passed
          ? { kind: 'passed', label: PASSED_LABEL }
          : { kind: 'withheld', label: WITHHELD_LABEL },
        blockers: gate.conformance.blockers.map((b) => b.message),
        needsReview: gate.conformance.needsHumanReview.map((b) => b.message),
      };
      if (fragment.remediateResult) {
        fragmentVm.remediateResult = {
          before: fragment.remediateResult.before,
          after: fragment.remediateResult.after,
          issueDiffs: fragment.remediateResult.issueDiffs.map((d) => ({
            message: d.issue.message,
            fixed: d.fixed,
          })),
        };
      }
      return fragmentVm;
    }),
  };
  if (view.mode) vm.mode = view.mode;
  return vm;
}

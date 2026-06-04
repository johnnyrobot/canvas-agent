/**
 * PURE view-model mapping for the renderer.
 *
 * `turnViewToVm` turns a `TurnView` (the gated runtime output) into a flat,
 * render-ready `TurnVm`. The renderer (`renderer/renderer.ts`) does only DOM
 * work on top of this — all the decision logic (which badge, which messages to
 * surface) lives here so it can be unit-tested without a DOM.
 *
 * The badge is derived from the gate, never from the model: a fragment shows the
 * "passed" badge ONLY when the gate both passed its checks AND did not withhold
 * the badge (`A11Y_FAIL_OPEN=false`). Any blocker withholds it and the blocker
 * messages are surfaced instead.
 */
import type { TurnView } from '../contracts/index.js';

export type BadgeKind = 'passed' | 'withheld';

export interface BadgeVm {
  kind: BadgeKind;
  label: string;
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
}

export interface TurnVm {
  text: string;
  toolsUsed: string[];
  iterations: number;
  fragments: FragmentVm[];
}

const PASSED_LABEL = 'Accessibility checks passed';
const WITHHELD_LABEL = 'Accessibility checks withheld';

export function turnViewToVm(view: TurnView): TurnVm {
  return {
    text: view.text,
    toolsUsed: view.toolsUsed,
    iterations: view.iterations,
    fragments: view.fragments.map((fragment) => {
      const { gate } = fragment;
      const passed = gate.conformance.passedChecks && !gate.badgeWithheld;
      return {
        html: gate.html,
        passed,
        badge: passed
          ? { kind: 'passed', label: PASSED_LABEL }
          : { kind: 'withheld', label: WITHHELD_LABEL },
        blockers: gate.conformance.blockers.map((b) => b.message),
        needsReview: gate.conformance.needsHumanReview.map((b) => b.message),
      };
    }),
  };
}

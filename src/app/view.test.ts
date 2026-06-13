import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AuditIssue,
  GateResult,
  RemediateResult,
  TurnFragment,
  TurnView,
} from '../contracts/index.js';
import { turnViewToVm } from './view.js';

function gate(
  html: string,
  opts: { blockers?: AuditIssue[]; warnings?: AuditIssue[]; needsHumanReview?: AuditIssue[] } = {},
): GateResult {
  const blockers = opts.blockers ?? [];
  const badgeWithheld = blockers.length > 0;
  return {
    html,
    badgeWithheld,
    conformance: {
      passedChecks: !badgeWithheld,
      blockers,
      warnings: opts.warnings ?? [],
      needsHumanReview: opts.needsHumanReview ?? [],
    },
  };
}

function fragment(html: string, opts?: Parameters<typeof gate>[1]): TurnFragment {
  return { html, gate: gate(html, opts) };
}

test('carries text, toolsUsed and iterations straight through', () => {
  const view: TurnView = {
    text: 'Here is your syllabus.',
    fragments: [],
    toolsUsed: ['render_template', 'check_contrast'],
    iterations: 3,
  };
  const vm = turnViewToVm(view);
  assert.equal(vm.text, 'Here is your syllabus.');
  assert.deepEqual(vm.toolsUsed, ['render_template', 'check_contrast']);
  assert.equal(vm.iterations, 3);
  assert.deepEqual(vm.fragments, []);
});

test('a passing fragment maps to a "passed" badge', () => {
  const view: TurnView = {
    text: '',
    fragments: [fragment('<h2>Welcome</h2>')],
    toolsUsed: [],
    iterations: 1,
  };
  const [vm] = turnViewToVm(view).fragments;
  assert.ok(vm);
  assert.equal(vm.passed, true);
  assert.equal(vm.badge.kind, 'passed');
  assert.equal(vm.badge.label, 'Accessibility checks passed');
  assert.equal(vm.html, '<h2>Welcome</h2>');
  assert.deepEqual(vm.blockers, []);
});

test('a fragment surfaces auditor warnings even when the badge passes (C14)', () => {
  // The auditor computes conformance.warnings (moderate WCAG issues); they must
  // reach the UI. Previously the view dropped them, so a "passed" fragment hid
  // real findings — the view-boundary version of badging-while-failing.
  const view: TurnView = {
    text: '',
    fragments: [
      fragment('<table></table>', {
        warnings: [{ id: 'table-caption', severity: 'warning', message: 'Table has no caption' }],
      }),
    ],
    toolsUsed: [],
    iterations: 1,
  };
  const [vm] = turnViewToVm(view).fragments;
  assert.ok(vm);
  assert.equal(vm.passed, true); // a moderate warning does not withhold the badge…
  assert.deepEqual(vm.warnings, ['Table has no caption']); // …but it is still surfaced
});

test('a badgeWithheld fragment maps to a "checks withheld" badge and surfaces blockers', () => {
  const view: TurnView = {
    text: '',
    fragments: [
      fragment('<img>', {
        blockers: [{ id: 'img-alt-missing', severity: 'blocker', message: 'Image missing alt text' }],
      }),
    ],
    toolsUsed: [],
    iterations: 1,
  };
  const [vm] = turnViewToVm(view).fragments;
  assert.ok(vm);
  assert.equal(vm.passed, false);
  assert.equal(vm.badge.kind, 'withheld');
  assert.equal(vm.badge.label, 'Accessibility checks withheld');
  assert.deepEqual(vm.blockers, ['Image missing alt text']);
});

test('surfaces items that need human review (alerts/advisories)', () => {
  const view: TurnView = {
    text: '',
    fragments: [
      fragment('<a href="x.pdf">PDF</a>', {
        needsHumanReview: [{ id: 'link_pdf', severity: 'alert', message: 'Links to a PDF — verify it is accessible' }],
      }),
    ],
    toolsUsed: [],
    iterations: 1,
  };
  const [vm] = turnViewToVm(view).fragments;
  assert.ok(vm);
  assert.equal(vm.passed, true);
  assert.deepEqual(vm.needsReview, ['Links to a PDF — verify it is accessible']);
});

test('preserves fragment order and renders one VM per fragment', () => {
  const view: TurnView = {
    text: '',
    fragments: [fragment('<h2>One</h2>'), fragment('<h2>Two</h2>')],
    toolsUsed: [],
    iterations: 1,
  };
  const vm = turnViewToVm(view);
  assert.equal(vm.fragments.length, 2);
  assert.equal(vm.fragments[0]?.html, '<h2>One</h2>');
  assert.equal(vm.fragments[1]?.html, '<h2>Two</h2>');
});

test('surfaces the resolved turn mode when present', () => {
  const view: TurnView = {
    text: '',
    fragments: [],
    toolsUsed: [],
    iterations: 1,
    mode: 'build',
  };
  assert.equal(turnViewToVm(view).mode, 'build');
});

test('omits mode when the turn did not resolve one (Auto with no fragments yet)', () => {
  const view: TurnView = { text: '', fragments: [], toolsUsed: [], iterations: 1 };
  const vm = turnViewToVm(view);
  assert.equal(vm.mode, undefined);
  assert.ok(!('mode' in vm), 'mode key is omitted, not set to undefined');
});

test('a fragment without a remediateResult omits the remediate view-model', () => {
  const view: TurnView = {
    text: '',
    fragments: [fragment('<h2>Plain</h2>')],
    toolsUsed: [],
    iterations: 1,
  };
  const [vm] = turnViewToVm(view).fragments;
  assert.ok(vm);
  assert.equal(vm.remediateResult, undefined);
  assert.ok(!('remediateResult' in vm), 'remediateResult key is omitted');
});

test('maps a remediateResult to before/after + per-issue fixed flags', () => {
  const after = '<img src="x.png" alt="A labelled diagram">';
  const remediateResult: RemediateResult = {
    before: '<img src="x.png">',
    after,
    issueDiffs: [
      { issue: { id: 'img-alt-missing', severity: 'blocker', message: 'Image missing alt text' }, fixed: true },
      { issue: { id: 'contrast-low', severity: 'warning', message: 'Low contrast heading' }, fixed: false },
    ],
    gate: gate(after),
  };
  const frag: TurnFragment = { html: after, gate: gate(after), remediateResult };
  const view: TurnView = {
    text: 'Remediated.',
    fragments: [frag],
    toolsUsed: ['remediate_html'],
    iterations: 1,
    mode: 'remediate',
  };
  const [vm] = turnViewToVm(view).fragments;
  assert.ok(vm);
  assert.ok(vm.remediateResult);
  assert.equal(vm.remediateResult.before, '<img src="x.png">');
  assert.equal(vm.remediateResult.after, after);
  assert.deepEqual(vm.remediateResult.issueDiffs, [
    { message: 'Image missing alt text', fixed: true },
    { message: 'Low contrast heading', fixed: false },
  ]);
});

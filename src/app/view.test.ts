import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditIssue, GateResult, TurnFragment, TurnView } from '../contracts/index.js';
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

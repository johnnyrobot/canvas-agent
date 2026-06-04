import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enforceGate, type AuditIssue, type GateDeps } from './gate.js';

function deps(issues: AuditIssue[], removedSemantic: string[] = [], repaired = '<h2>Ok</h2>'): GateDeps {
  return {
    validateAllowlist: async () => ({ html: repaired, removedSemantic }),
    audit: async () => ({ issues }),
  };
}

test('clean output passes and shows the badge', async () => {
  const res = await enforceGate('<h2>Ok</h2>', deps([]));
  assert.equal(res.badgeWithheld, false);
  assert.equal(res.conformance.passedChecks, true);
  assert.equal(res.conformance.blockers.length, 0);
});

test('a blocker withholds the badge (A11Y_FAIL_OPEN=false)', async () => {
  const res = await enforceGate('<img>', deps([
    { id: 'img-alt-missing', severity: 'blocker', message: 'Image missing alt' },
  ]));
  assert.equal(res.badgeWithheld, true);
  assert.equal(res.conformance.passedChecks, false);
  assert.equal(res.conformance.blockers[0]?.id, 'img-alt-missing');
});

test('warnings/alerts do NOT withhold the badge but are surfaced', async () => {
  const res = await enforceGate('<table></table>', deps([
    { id: 'table-caption', severity: 'warning', message: 'no caption' },
    { id: 'link_pdf', severity: 'alert', message: 'links to a PDF' },
  ]));
  assert.equal(res.badgeWithheld, false);
  assert.equal(res.conformance.warnings.length, 1);
  assert.equal(res.conformance.needsHumanReview.length, 1);
});

test('removing a semantic element during allowlist repair is itself a blocker', async () => {
  const res = await enforceGate('<h2>x</h2>', deps([], ['nav']));
  assert.equal(res.badgeWithheld, true);
  assert.ok(res.conformance.blockers.some((b) => b.id === 'allowlist-removed-semantic'));
});

test('the returned html is the allowlist-gated (repaired) html', async () => {
  const res = await enforceGate('<h1>raw</h1>', deps([], [], '<h2>repaired</h2>'));
  assert.equal(res.html, '<h2>repaired</h2>');
});

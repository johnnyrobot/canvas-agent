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

test('a serious AA failure (error severity) withholds the badge (C2)', async () => {
  // axe `serious` violations (e.g. link-name, button-name) map to severity `error`.
  // They are *definite* WCAG AA failures, so the "passed checks" badge must be withheld.
  const res = await enforceGate('<a href="#"></a>', deps([
    { id: 'link-name', severity: 'error', message: 'Link has no discernible text' },
  ]));
  assert.equal(res.badgeWithheld, true);
  assert.equal(res.conformance.passedChecks, false);
  assert.equal(res.conformance.blockers[0]?.id, 'link-name');
  // A blocker is not also double-counted as a (non-blocking) warning.
  assert.equal(res.conformance.warnings.length, 0);
});

test('removing a semantic element during allowlist repair is itself a blocker', async () => {
  const res = await enforceGate('<h2>x</h2>', deps([], ['nav']));
  assert.equal(res.badgeWithheld, true);
  assert.ok(res.conformance.blockers.some((b) => b.id.startsWith('allowlist-removed-semantic')));
});

test('each removed semantic tag gets a UNIQUE blocker id (C12)', async () => {
  // A constant id collapses multiple removed tags into one row in the downstream
  // diff (uniqueById/afterIds key on id), under-counting semantic loss and
  // mis-attributing "fixed". The id must carry the tag identity.
  const res = await enforceGate('<x>', deps([], ['nav', 'aside']));
  const semIds = res.conformance.blockers
    .filter((b) => b.id.startsWith('allowlist-removed-semantic'))
    .map((b) => b.id);
  assert.equal(semIds.length, 2);
  assert.equal(new Set(semIds).size, 2, 'removed-semantic blocker ids must be unique per tag');
});

test('the returned html is the allowlist-gated (repaired) html', async () => {
  const res = await enforceGate('<h1>raw</h1>', deps([], [], '<h2>repaired</h2>'));
  assert.equal(res.html, '<h2>repaired</h2>');
});

/**
 * Tests for the remediate-review screen model (ADR-0002).
 *
 * Every one of these was unreachable before the extraction: the logic lived
 * inside `renderRemediationReview()`, welded to DOM construction, and the
 * selection lived in a module-scope `let` that no test could touch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditIssue, GateResult, TurnView } from '../../contracts/index.js';
import { createRemediateReviewModel, type ReviewSource } from './remediate-review.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const issue = (
  id: string,
  message: string,
  severity: AuditIssue['severity'],
  category?: AuditIssue['category'],
): AuditIssue => (category ? { id, severity, message, category } : { id, severity, message });

const gate = (parts: {
  blockers?: AuditIssue[];
  warnings?: AuditIssue[];
  needsHumanReview?: AuditIssue[];
  html?: string;
}): GateResult => {
  const blockers = parts.blockers ?? [];
  return {
    html: parts.html ?? '<p>after</p>',
    badgeWithheld: blockers.length > 0,
    conformance: {
      passedChecks: blockers.length === 0,
      blockers,
      warnings: parts.warnings ?? [],
      needsHumanReview: parts.needsHumanReview ?? [],
    },
  };
};

/** A finished remediation run. `repaired: false` means no `remediateResult`. */
function run(parts: {
  blockers?: AuditIssue[];
  warnings?: AuditIssue[];
  needsHumanReview?: AuditIssue[];
  repaired?: boolean;
  fixed?: number;
  before?: string;
  after?: string;
}): TurnView {
  const g = gate(parts);
  const fixedCount = parts.fixed ?? 0;
  const fragment: TurnView['fragments'][number] = { html: parts.after ?? '<p>after</p>', gate: g };
  if (parts.repaired !== false) {
    fragment.remediateResult = {
      before: parts.before ?? '<p>before</p>',
      after: parts.after ?? '<p>after</p>',
      issueDiffs: Array.from({ length: fixedCount }, (_, i) => ({
        issue: issue(`fixed-${i}`, 'fixed', 'error'),
        fixed: true,
      })),
      gate: g,
    };
  }
  return { text: 'done', fragments: [fragment], toolsUsed: [], iterations: 1 };
}

const PASTED: ReviewSource = { kind: 'paste' };
const CANVAS_FULL: ReviewSource = {
  kind: 'canvas',
  pageTitle: 'Week 3 — Reading',
  baseUrl: 'https://laccd.instructure.com',
  courseId: '1842',
  pageId: 'week-3-reading',
};

const MIXED = run({
  blockers: [issue('image-alt', 'Image has no alternative text', 'blocker', 'error')],
  warnings: [issue('heading-order', 'Heading level skipped', 'warning', 'structure')],
  needsHumanReview: [issue('contrast', 'Text contrast is below 4.5:1', 'alert', 'contrast')],
  fixed: 4,
});

/** A different page whose findings happen to share the `contrast` id. */
const OTHER_PAGE = run({
  blockers: [issue('link-name', 'Link has no discernible text', 'blocker', 'aria')],
  warnings: [issue('contrast', 'Text contrast is below 4.5:1', 'warning', 'contrast')],
  fixed: 1,
});

const WARNINGS_ONLY = run({
  warnings: [issue('contrast', 'Text contrast is below 4.5:1', 'warning', 'contrast')],
  fixed: 2,
});

const reviewing = (view: TurnView | undefined, source: ReviewSource = PASTED) => {
  const model = createRemediateReviewModel();
  const screen = model.screenFor({ run: view, source });
  return { model, screen };
};

// ── Selection: the state that used to be orphaned ────────────────────────────

test('the first finding is selected when nobody has chosen one', () => {
  const { screen } = reviewing(MIXED);
  assert.equal(screen.kind, 'review');
  assert.ok(screen.kind === 'review');
  assert.equal(screen.view.selectedId, 'image-alt');
  assert.equal(screen.view.detail.position, 'Issue 1 of 3');
});

test('selecting a finding moves the detail pane to it', () => {
  const { model } = reviewing(MIXED);
  model.select('contrast');
  const screen = model.screenFor({ run: MIXED, source: PASTED });
  assert.ok(screen.kind === 'review');
  assert.equal(screen.view.selectedId, 'contrast');
  assert.equal(screen.view.detail.position, 'Issue 3 of 3');
  assert.equal(screen.view.detail.title, 'Text contrast is below 4.5:1');
});

test('A NEW CHECK RESETS THE SELECTION — it never carries over between pages', () => {
  // The bug this slice exists to kill. `reviewSelectedId` was a module-scope
  // `let` that nothing reset, and the fallback is `find(id) ?? issues[0]` — so a
  // second run sharing a finding id (`contrast` here) silently left the
  // instructor mid-list on a finding they never chose, for a page they had left.
  const { model } = reviewing(MIXED);
  model.select('contrast');

  const screen = model.screenFor({ run: OTHER_PAGE, source: PASTED });

  assert.ok(screen.kind === 'review');
  assert.equal(screen.view.selectedId, 'link-name', 'back to the first finding of the NEW run');
  assert.equal(screen.view.detail.position, 'Issue 1 of 2');
});

test('a new set of findings resets the selection even if the run OBJECT is reused', () => {
  // The reset must not depend on allocation behaviour. Both renderer assignment
  // sites build a fresh TurnView today, but a cached or mutated-in-place view
  // would otherwise silently reintroduce the very bug this model prevents.
  const model = createRemediateReviewModel();
  const recycled: TurnView = JSON.parse(JSON.stringify(MIXED)) as TurnView;
  model.screenFor({ run: recycled, source: PASTED });
  model.select('contrast');

  // Same object, mutated to carry a different page's findings.
  recycled.fragments = JSON.parse(JSON.stringify(OTHER_PAGE.fragments)) as TurnView['fragments'];
  const screen = model.screenFor({ run: recycled, source: PASTED });

  assert.ok(screen.kind === 'review');
  assert.equal(screen.view.selectedId, 'link-name', 'reset keyed on the findings, not the object');
});

test('re-rendering the same run keeps the selection', () => {
  const { model } = reviewing(MIXED);
  model.select('heading-order');
  model.screenFor({ run: MIXED, source: PASTED });
  const screen = model.screenFor({ run: MIXED, source: PASTED });
  assert.ok(screen.kind === 'review');
  assert.equal(screen.view.selectedId, 'heading-order', 'a re-render is not a new check');
});

test('a selection for a finding that is not on screen is refused, not silently swallowed', () => {
  const { model } = reviewing(MIXED);
  const action = model.select('no-such-rule');
  assert.equal(action.kind, 'notice');
  assert.match(action.kind === 'notice' ? action.text : '', /no such finding/i);
});

// ── Findings, ordering and the summary ───────────────────────────────────────

test('findings are listed blockers first, then warnings, then human review', () => {
  const { screen } = reviewing(MIXED);
  assert.ok(screen.kind === 'review');
  assert.deepEqual(
    screen.view.issues.map((i) => [i.id, i.severity]),
    [
      ['image-alt', 'fail'],
      ['heading-order', 'warn'],
      ['contrast', 'warn'],
    ],
  );
});

test('the summary counts fails, things needing review, and auto-fixes separately', () => {
  const { screen } = reviewing(MIXED);
  assert.ok(screen.kind === 'review');
  assert.deepEqual(screen.view.summary, { fail: 1, warn: 2, pass: 4 });
});

// ── The withheld-badge safety rule ───────────────────────────────────────────

test('a page that still fails can be NEITHER downloaded nor copied into Canvas', () => {
  const { model, screen } = reviewing(MIXED);
  assert.ok(screen.kind === 'review');
  assert.equal(screen.can.download, false);
  assert.equal(screen.can.copyForCanvas, false);

  for (const action of [model.download(), model.copyForCanvas()]) {
    assert.equal(action.kind, 'notice', 'refused, rather than handing over a failing page');
    assert.match(action.kind === 'notice' ? action.text : '', /still fails/i);
  }
});

test('a page with only warnings can be taken away', () => {
  const { model, screen } = reviewing(WARNINGS_ONLY);
  assert.ok(screen.kind === 'review');
  assert.equal(screen.can.download, true);
  assert.equal(screen.can.copyForCanvas, true);

  const download = model.download();
  assert.equal(download.kind, 'download');
  assert.equal(download.kind === 'download' ? download.html : '', '<p>after</p>');

  const copy = model.copyForCanvas();
  assert.equal(copy.kind, 'copy');
  assert.match(copy.kind === 'copy' ? copy.copied : '', /Canvas editor/);
});

// ── Audit clear vs a genuinely empty screen ──────────────────────────────────

test('a check that found nothing but repaired something shows "Audit clear"', () => {
  const { screen } = reviewing(run({ fixed: 6 }));
  assert.ok(screen.kind === 'review');
  assert.deepEqual(screen.view.issues, []);
  assert.equal(screen.view.selectedId, '');
  assert.equal(screen.view.detail.tag, 'Audit clear');
  assert.match(screen.view.detail.description, /6 issues were auto-fixed/);
  assert.equal(screen.can.download, true, 'nothing failed, so it can be taken away');
});

test('no check at all is an empty screen', () => {
  assert.equal(reviewing(undefined).screen.kind, 'empty');
});

test('a check with neither findings nor a repair is also an empty screen', () => {
  assert.equal(reviewing(run({ repaired: false })).screen.kind, 'empty');
});

test('the auto-fix note is singular for exactly one fix', () => {
  const { screen } = reviewing(run({ fixed: 1 }));
  assert.ok(screen.kind === 'review');
  assert.match(screen.view.detail.description, /1 issue was auto-fixed/);
});

// ── Where the page came from ─────────────────────────────────────────────────

test('the page heading names the source', () => {
  const pasted = reviewing(MIXED, PASTED).screen;
  assert.ok(pasted.kind === 'review');
  assert.deepEqual(pasted.view.page, { title: 'Pasted HTML', path: 'pasted-source' });

  const doc = reviewing(MIXED, { kind: 'document', fileName: 'syllabus.docx' }).screen;
  assert.ok(doc.kind === 'review');
  assert.deepEqual(doc.view.page, { title: 'syllabus.docx', path: 'document' });

  const canvas = reviewing(MIXED, CANVAS_FULL).screen;
  assert.ok(canvas.kind === 'review');
  assert.deepEqual(canvas.view.page, { title: 'Week 3 — Reading', path: 'https://laccd.instructure.com' });
});

test('"Open in Canvas" needs the address, the course AND the page', () => {
  const full = reviewing(MIXED, CANVAS_FULL).screen;
  assert.ok(full.kind === 'review');
  assert.equal(full.can.canvasEditUrl, 'https://laccd.instructure.com/courses/1842/pages/week-3-reading/edit');

  for (const missing of [
    { ...CANVAS_FULL, courseId: '' },
    { ...CANVAS_FULL, baseUrl: '' },
    { ...CANVAS_FULL, pageId: undefined },
    PASTED,
  ] as ReviewSource[]) {
    const screen = reviewing(MIXED, missing).screen;
    assert.ok(screen.kind === 'review');
    assert.equal(screen.can.canvasEditUrl, undefined, `two out of three is copy-only: ${JSON.stringify(missing)}`);
  }
});

test('a trailing slash on the Canvas address does not double up in the link', () => {
  const screen = reviewing(MIXED, { ...CANVAS_FULL, baseUrl: 'https://laccd.instructure.com/' }).screen;
  assert.ok(screen.kind === 'review');
  assert.equal(screen.can.canvasEditUrl, 'https://laccd.instructure.com/courses/1842/pages/week-3-reading/edit');
});

// ── The remaining actions ────────────────────────────────────────────────────

test('applying a fix names the finding it belongs to', () => {
  const { model } = reviewing(MIXED);
  const action = model.apply('heading-order');
  assert.equal(action.kind, 'notice');
  assert.match(action.kind === 'notice' ? action.text : '', /Heading level skipped/);
});

test('skipping says so without changing the selection', () => {
  const { model } = reviewing(MIXED);
  model.select('contrast');
  assert.deepEqual(model.skip(), { kind: 'notice', text: 'Issue skipped.' });
  const screen = model.screenFor({ run: MIXED, source: PASTED });
  assert.ok(screen.kind === 'review');
  assert.equal(screen.view.selectedId, 'contrast');
});

test('copying just this fix hands over the repaired page', () => {
  const { model } = reviewing(MIXED);
  const action = model.copyFix();
  assert.equal(action.kind, 'copy');
  assert.equal(action.kind === 'copy' ? action.text : '', '<p>after</p>');
});

test('actions on an empty screen are refused rather than throwing', () => {
  const { model } = reviewing(undefined);
  for (const action of [model.download(), model.copyForCanvas(), model.copyFix(), model.skip(), model.apply('x')]) {
    assert.equal(action.kind, 'notice', 'no run, so nothing to act on');
  }
});

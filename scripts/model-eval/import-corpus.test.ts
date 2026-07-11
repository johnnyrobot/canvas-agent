/**
 * Unit tests for the real-corpus importer's pure parts: rule-id → task
 * mapping, ratio parsing, gold-shaping, presence detection, and image
 * extraction — all exercised with synthetic `AuditIssue[]` input, no browser.
 *
 * The full `importFixtures` pipeline is also tested offline via an injected
 * stub auditor (no Chromium). A real-Chromium end-to-end pass is gated behind
 * `RUN_BROWSER_INTEGRATION`, mirroring `render.test.ts`'s skip convention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  RULES,
  issuesForTask,
  parseRatio,
  goldForTask,
  tasksForPage,
  extractImages,
  wrapPage,
  importFixtures,
} from './import-corpus.js';
import type { AuditIssue, Auditor } from '../../src/contracts/index.js';

const truthy = (v: string | undefined): boolean => ['1', 'true', 'yes'].includes((v ?? '').toLowerCase());
const optedIn = truthy(process.env.RUN_BROWSER_INTEGRATION);
const skip: true | string | false = optedIn ? false : 'set RUN_BROWSER_INTEGRATION=1 to run';

// ---------------------------------------------------------------------------
// issuesForTask / RULES
// ---------------------------------------------------------------------------

test('issuesForTask: matches by rule id from the frozen RULES map', () => {
  const issues: AuditIssue[] = [
    { id: 'heading-order', severity: 'error', message: 'skip', category: 'structure' },
    { id: 'image-alt', severity: 'error', message: 'missing alt', category: 'error' },
  ];
  assert.equal(issuesForTask('heading', issues).length, 1);
  assert.equal(issuesForTask('heading', issues)[0]!.id, 'heading-order');
  assert.equal(issuesForTask('alt', issues).length, 1);
  assert.equal(issuesForTask('table', issues).length, 0);
});

test('issuesForTask: contrast also matches on category==="contrast" even when the rule id is not a color-contrast* id', () => {
  // The deterministic contrast engine's issues carry id:"contrast", not an axe rule id.
  const issues: AuditIssue[] = [
    { id: 'contrast', severity: 'blocker', message: 'Text contrast 2.85:1 is below the WCAG AA minimum of 4.5:1.', category: 'contrast' },
  ];
  assert.equal(issuesForTask('contrast', issues).length, 1);
});

test('issuesForTask: an unrelated category=="contrast" issue never leaks into a non-contrast task', () => {
  const issues: AuditIssue[] = [{ id: 'contrast', severity: 'blocker', message: 'x', category: 'contrast' }];
  assert.equal(issuesForTask('heading', issues).length, 0);
  assert.equal(issuesForTask('table', issues).length, 0);
  assert.equal(issuesForTask('alt', issues).length, 0);
});

test('RULES: exactly the mapping specified (no invented rules)', () => {
  assert.deepEqual(RULES.alt, ['image-alt', 'role-img-alt', 'input-image-alt', 'object-alt', 'area-alt']);
  assert.deepEqual(RULES.contrast, ['color-contrast', 'color-contrast-enhanced']);
  assert.deepEqual(RULES.heading, ['heading-order', 'empty-heading', 'page-has-heading-one']);
  assert.deepEqual(RULES.table, [
    'th-has-data-cells',
    'td-has-header',
    'td-headers-attr',
    'scope-attr-valid',
    'empty-table-header',
    'table-duplicate-name',
  ]);
});

// ---------------------------------------------------------------------------
// parseRatio
// ---------------------------------------------------------------------------

test('parseRatio: parses "2.85:1" out of a message', () => {
  assert.equal(parseRatio('Text contrast 2.85:1 is below the WCAG AA minimum of 4.5:1 for normal text.'), 2.85);
});

test('parseRatio: parses an integer ratio like "3:1"', () => {
  assert.equal(parseRatio('ratio is 3:1'), 3);
});

test('parseRatio: returns undefined when no ratio is present', () => {
  assert.equal(parseRatio('Elements must meet minimum color contrast ratio thresholds'), undefined);
});

// ---------------------------------------------------------------------------
// goldForTask
// ---------------------------------------------------------------------------

test('goldForTask: a heading-order violation yields heading gold status "fail"', () => {
  const issues: AuditIssue[] = [
    { id: 'heading-order', severity: 'error', message: 'Heading levels should only increase by one', category: 'structure' },
  ];
  const { gold } = goldForTask('heading', issues, 0);
  assert.equal((gold as { status: string }).status, 'fail');
});

test('goldForTask: no matching rules yields "pass"', () => {
  // A contrast issue present, but we're scoring the heading task — no match.
  const issues: AuditIssue[] = [{ id: 'color-contrast', severity: 'error', message: 'x', category: 'contrast' }];
  const { gold, rationale } = goldForTask('heading', issues, 0);
  assert.equal((gold as { status: string }).status, 'pass');
  assert.equal((gold as { findings: unknown[] }).findings.length, 0);
  assert.equal(rationale, "no axe violations in this task's rule set");
});

test('goldForTask: alt gold emits one figure entry per image', () => {
  const { gold } = goldForTask('alt', [], 3);
  const figures = (gold as { figures: unknown[] }).figures;
  assert.equal(figures.length, 3);
});

test('goldForTask: alt figures are "fail"/"missing" when an alt rule matched, "pass" otherwise', () => {
  const failIssues: AuditIssue[] = [{ id: 'image-alt', severity: 'error', message: 'Images must have alt text', category: 'error' }];
  const { gold: failGold } = goldForTask('alt', failIssues, 2);
  const failFigures = (failGold as { figures: { status: string; issue_type: string }[] }).figures;
  assert.equal(failFigures.length, 2);
  for (const f of failFigures) {
    assert.equal(f.status, 'fail');
    assert.equal(f.issue_type, 'missing');
  }

  const { gold: passGold } = goldForTask('alt', [], 2);
  const passFigures = (passGold as { figures: { status: string }[] }).figures;
  for (const f of passFigures) assert.equal(f.status, 'pass');
});

test('goldForTask: a contrast issue with "2.85:1" in the message parses ratio 2.85', () => {
  const issues: AuditIssue[] = [
    {
      id: 'color-contrast',
      severity: 'error',
      message: 'Text contrast 2.85:1 is below the WCAG AA minimum of 4.5:1 for normal text (#999999 on #ffffff).',
      category: 'contrast',
    },
  ];
  const { gold } = goldForTask('contrast', issues, 0);
  const g = gold as { issues: { ratio?: number; description: string }[] };
  assert.equal(g.issues.length, 1);
  assert.equal(g.issues[0]!.ratio, 2.85);
});

test('goldForTask: contrast issue omits ratio when unparseable', () => {
  const issues: AuditIssue[] = [{ id: 'color-contrast', severity: 'error', message: 'no numeric ratio here', category: 'contrast' }];
  const { gold } = goldForTask('contrast', issues, 0);
  const g = gold as { issues: { ratio?: number }[] };
  assert.equal(g.issues.length, 1);
  assert.equal('ratio' in g.issues[0]!, false);
});

test('goldForTask: contrast with no issues is pass (empty array)', () => {
  const { gold } = goldForTask('contrast', [], 0);
  assert.deepEqual(gold, { issues: [] });
});

test('goldForTask: table findings use fixer "fix_table_headers" and confidence 0.9', () => {
  const issues: AuditIssue[] = [
    { id: 'th-has-data-cells', severity: 'error', message: 'Header row uses TD cells', category: 'structure' },
  ];
  const { gold } = goldForTask('table', issues, 0);
  const g = gold as { status: string; confidence: number; findings: { issue_id: string; fixer: string }[] };
  assert.equal(g.status, 'fail');
  assert.equal(g.confidence, 0.9);
  assert.equal(g.findings[0]!.issue_id, 'th-has-data-cells');
  assert.equal(g.findings[0]!.fixer, 'fix_table_headers');
});

// ---------------------------------------------------------------------------
// presence detection / image extraction
// ---------------------------------------------------------------------------

test('tasksForPage: contrast always applies; alt/heading/table only when present', () => {
  const textOnly = wrapPage('<p>Just a paragraph.</p>');
  assert.deepEqual(tasksForPage(textOnly), ['contrast']);

  const withImg = wrapPage('<p>x</p><img src="a.png" alt="a">');
  assert.deepEqual(tasksForPage(withImg), ['contrast', 'alt']);

  const withHeadingAndTable = wrapPage('<h2>Week 1</h2><table><tr><td>a</td></tr></table>');
  assert.deepEqual(tasksForPage(withHeadingAndTable), ['contrast', 'heading', 'table']);
});

test('extractImages: returns src + alt (null when the attribute is absent) in document order', () => {
  const html = wrapPage('<img src="one.png" alt="First"><img src="two.png">');
  const images = extractImages(html);
  assert.equal(images.length, 2);
  assert.deepEqual(images[0], { src: 'one.png', alt: 'First' });
  assert.deepEqual(images[1], { src: 'two.png', alt: null });
});

// ---------------------------------------------------------------------------
// importFixtures — full pipeline offline via an injected stub auditor.
// ---------------------------------------------------------------------------

test('importFixtures: one fixture per applicable task, needs-label for alt-pass and heading-fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-corpus-test-'));
  try {
    await writeFile(
      path.join(dir, 'week-1.html'),
      '<h1>Syllabus</h1><h4>Week 1</h4><img src="chart.png" alt="Enrollment chart"><table><tr><td>a</td></tr></table>',
    );

    const stubAuditor: Auditor = async (html: string) => {
      const issues: AuditIssue[] = [];
      if (html.includes('<h4>')) {
        issues.push({ id: 'heading-order', severity: 'error', message: 'Heading levels should only increase by one', category: 'structure' });
      }
      return { issues };
    };

    const { fixtures, needsLabel, pagesImported } = await importFixtures({ htmlDir: dir, auditor: stubAuditor });

    assert.equal(pagesImported, 1);
    // contrast + alt + heading + table = 4 fixtures for this one page.
    assert.equal(fixtures.length, 4);
    const tasks = fixtures.map((f) => f.task).sort();
    assert.deepEqual(tasks, ['alt', 'contrast', 'heading', 'table']);

    const altFixture = fixtures.find((f) => f.task === 'alt')!;
    assert.equal((altFixture.gold as { figures: { status: string }[] }).figures[0]!.status, 'pass');

    const headingFixture = fixtures.find((f) => f.task === 'heading')!;
    assert.equal((headingFixture.gold as { status: string }).status, 'fail');

    // alt is a pass (axe found nothing) -> needs-label for quality review.
    const altLabel = needsLabel.find((n) => n.task === 'alt');
    assert.ok(altLabel, 'expected an alt needs-label entry');
    assert.equal(altLabel!.images!.length, 1);
    assert.equal(altLabel!.images![0]!.alt, 'Enrollment chart');

    // heading is a fail -> needs-label because correct_tag is undecidable.
    const headingLabel = needsLabel.find((n) => n.task === 'heading');
    assert.ok(headingLabel, 'expected a heading needs-label entry');

    // table is a pass in this stub (no table rule issues) -> no needs-label.
    assert.equal(needsLabel.some((n) => n.task === 'table'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importFixtures: a body with no images/tables gets contrast + heading (the page title IS an H1)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-corpus-test-'));
  try {
    await writeFile(path.join(dir, 'plain.html'), '<p>Just text, nothing else.</p>');
    const stubAuditor: Auditor = async () => ({ issues: [] });
    const { fixtures } = await importFixtures({ htmlDir: dir, auditor: stubAuditor });
    // wrapPage renders the page title as <h1>, mirroring Canvas — so every page
    // has a heading to judge. No <img>/<table>, so no alt/table fixture.
    assert.deepEqual(fixtures.map((f) => f.task).sort(), ['contrast', 'heading']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real-Chromium integration — gated, mirrors render.test.ts's convention.
// ---------------------------------------------------------------------------

test('importFixtures: end-to-end against the real audit()', { skip }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'import-corpus-real-'));
  try {
    await writeFile(
      path.join(dir, 'real-page.html'),
      '<h1>Syllabus</h1><p style="color:#999999">Low contrast body text.</p>',
    );
    const { fixtures } = await importFixtures({ htmlDir: dir });
    assert.ok(fixtures.length >= 1);
    const contrastFixture = fixtures.find((f) => f.task === 'contrast');
    assert.ok(contrastFixture);
    assert.ok(((contrastFixture!.gold as { issues: unknown[] }).issues.length) >= 1, 'expected a real contrast failure to be detected');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

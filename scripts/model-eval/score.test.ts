/**
 * Unit tests for the remedy-harness scoring port.
 * See `.frugal-fable/eval-spec/remedy-eval-contracts.md` for the formulas
 * being ported and `score.ts` for per-function citations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonish, normalizedStatus, contrastRatios, headingPairs, scoreOne, summarize } from './score.js';
import type { RowScore, TaskKey } from './types.js';

// ---------------------------------------------------------------------------
// parseJsonish (§0.6)
// ---------------------------------------------------------------------------

test('parseJsonish: bare JSON parses', () => {
  const result = parseJsonish('{"status": "pass"}');
  assert.deepEqual(result, { status: 'pass' });
});

test('parseJsonish: fenced ```json block strips the fence', () => {
  const raw = '```json\n{"status": "fail", "issues": []}\n```';
  const result = parseJsonish(raw);
  assert.deepEqual(result, { status: 'fail', issues: [] });
});

test('parseJsonish: fenced block with no language tag also strips', () => {
  const raw = '```\n{"a": 1}\n```';
  assert.deepEqual(parseJsonish(raw), { a: 1 });
});

test('parseJsonish: garbage input returns null, never throws', () => {
  assert.equal(parseJsonish('not json at all {{{'), null);
  assert.equal(parseJsonish(''), null);
  assert.equal(parseJsonish('```json\n{broken\n```'), null);
});

// ---------------------------------------------------------------------------
// normalizedStatus (§0.8) — one shape per task from the spec's gold schemas
// ---------------------------------------------------------------------------

test('normalizedStatus: alt — derived fail from figures[] entry status', () => {
  const gold = {
    figures: [
      { figure_index: 1, status: 'pass' },
      { figure_index: 2, status: 'fail' },
    ],
  };
  assert.equal(normalizedStatus(gold, 'alt'), 'fail');
});

test('normalizedStatus: alt — derived pass when all figures pass', () => {
  const gold = { figures: [{ figure_index: 1, status: 'pass' }] };
  assert.equal(normalizedStatus(gold, 'alt'), 'pass');
});

test('normalizedStatus: alt — derived pass on empty figures list', () => {
  assert.equal(normalizedStatus({ figures: [] }, 'alt'), 'pass');
});

test('normalizedStatus: alt — falls back to issues[] alt key', () => {
  const gold = { issues: [{ status: 'error' }] };
  assert.equal(normalizedStatus(gold, 'alt'), 'fail');
});

test('normalizedStatus: contrast — empty issues[] is pass', () => {
  const gold = { issues: [] };
  assert.equal(normalizedStatus(gold, 'contrast'), 'pass');
});

test('normalizedStatus: contrast — non-empty issues[] is fail', () => {
  const gold = {
    issues: [{ severity: 'error', description: 'low contrast', ratio: 2.38 }],
  };
  assert.equal(normalizedStatus(gold, 'contrast'), 'fail');
});

test('normalizedStatus: table — reads the literal status key', () => {
  const gold = { status: 'pass', confidence: 0.85, findings: [] };
  assert.equal(normalizedStatus(gold, 'table'), 'pass');

  const goldFail = {
    status: 'fail',
    confidence: 0.6,
    findings: [{ issue_id: 'missing_table_headers', severity: 'error', message: 'x', fixer: 'fix_table_headers' }],
  };
  assert.equal(normalizedStatus(goldFail, 'table'), 'fail');
});

test('normalizedStatus: status key is case-insensitive and trimmed', () => {
  assert.equal(normalizedStatus({ status: '  PASS  ' }, 'table'), 'pass');
  assert.equal(normalizedStatus({ status: 'Fail' }, 'table'), 'fail');
});

test('normalizedStatus: heading — derived fail from non-empty findings[] (no literal status key)', () => {
  const gold = {
    findings: [
      { severity: 'error', element_index: 4, current_tag: 'H1', correct_tag: 'P', message: 'x', suggested_fix: 'y' },
    ],
  };
  assert.equal(normalizedStatus(gold, 'heading'), 'fail');
});

test('normalizedStatus: heading — derived pass on empty findings[]', () => {
  assert.equal(normalizedStatus({ findings: [] }, 'heading'), 'pass');
});

test('normalizedStatus: non-object input returns null', () => {
  assert.equal(normalizedStatus(null, 'table'), null);
  assert.equal(normalizedStatus('a string', 'table'), null);
  assert.equal(normalizedStatus([1, 2, 3], 'table'), null);
});

test('normalizedStatus: no recognizable shape returns null', () => {
  assert.equal(normalizedStatus({ foo: 'bar' }, 'reading_order' as TaskKey), null);
});

// ---------------------------------------------------------------------------
// contrastRatios (§2.4)
// ---------------------------------------------------------------------------

test('contrastRatios: collects ratio, skipping non-numeric entries', () => {
  const parsed = {
    issues: [{ ratio: 2.38 }, { ratio: 'not a number' }, { ratio: 4.4 }, {}],
  };
  assert.deepEqual(contrastRatios(parsed), [2.38, 4.4]);
});

test('contrastRatios: falls back to contrast_issues key', () => {
  const parsed = { contrast_issues: [{ ratio: 3.1 }] };
  assert.deepEqual(contrastRatios(parsed), [3.1]);
});

// ---------------------------------------------------------------------------
// headingPairs (§4.4)
// ---------------------------------------------------------------------------

test('headingPairs: alias keys are all scanned and concatenated', () => {
  const parsed = {
    findings: [{ element_index: 1, correct_tag: 'H2' }],
    corrections: [{ element_index: 2, correct_tag: 'H3' }],
  };
  assert.deepEqual(headingPairs(parsed), new Set(['1|H2', '2|H3']));
});

test('headingPairs: leading slash is stripped, tag uppercased', () => {
  const parsed = { findings: [{ element_index: 3, correct_tag: '/H3' }] };
  assert.deepEqual(headingPairs(parsed), new Set(['3|H3']));
});

test('headingPairs: span normalizes to Span (title case)', () => {
  const parsed = { findings: [{ element_index: 5, correct_tag: 'span' }] };
  assert.deepEqual(headingPairs(parsed), new Set(['5|Span']));
});

test('headingPairs: invalid tag is dropped', () => {
  const parsed = { findings: [{ element_index: 6, correct_tag: 'DIV' }] };
  assert.deepEqual(headingPairs(parsed), new Set());
});

test('headingPairs: a finding with no element_index is dropped', () => {
  const parsed = {
    findings: [
      { correct_tag: 'H1', message: 'missing heading, no clean tag mapping' },
      { element_index: 7, correct_tag: 'H1' },
    ],
  };
  assert.deepEqual(headingPairs(parsed), new Set(['7|H1']));
});

test('headingPairs: alt-key fallback (target_tag, expected_tag) and index aliases', () => {
  const parsed = {
    findings: [
      { index: 8, target_tag: 'H4' },
      { element: 9, expected_tag: 'P' },
    ],
  };
  assert.deepEqual(headingPairs(parsed), new Set(['8|H4', '9|P']));
});

// ---------------------------------------------------------------------------
// scoreOne (§0.8)
// ---------------------------------------------------------------------------

test('scoreOne: passFalsePositive when gold is pass and pred is fail', () => {
  const gold = { status: 'pass', findings: [] };
  const pred = { status: 'fail', findings: [{ element_index: 1, correct_tag: 'H2' }] };
  const row = scoreOne('table', gold, pred, 'fixture-1');
  assert.equal(row.goldStatus, 'pass');
  assert.equal(row.predStatus, 'fail');
  assert.equal(row.passFalsePositive, true);
  assert.equal(row.statusMatch, false);
});

test('scoreOne: contrast nearThreshold true when a ratio is 4.4 (within [4.2,4.8])', () => {
  const gold = { issues: [{ ratio: 4.4 }] };
  const pred = { issues: [] };
  const row = scoreOne('contrast', gold, pred, 'fixture-2');
  assert.equal(row.nearThreshold, true);
});

test('scoreOne: contrast nearThreshold false when no ratio is close to threshold', () => {
  const gold = { issues: [{ ratio: 2.0 }] };
  const pred = { issues: [{ ratio: 6.0 }] };
  const row = scoreOne('contrast', gold, pred, 'fixture-3');
  assert.equal(row.nearThreshold, false);
});

test('scoreOne: heading exactCorrections true on matching correction sets', () => {
  const gold = { status: 'fail', findings: [{ element_index: 4, correct_tag: 'P' }] };
  const pred = { status: 'fail', findings: [{ element_index: 4, correct_tag: 'P' }] };
  const row = scoreOne('heading', gold, pred, 'fixture-4');
  assert.equal(row.exactCorrections, true);
});

test('scoreOne: heading exactCorrections false when correction sets differ', () => {
  const gold = { status: 'fail', findings: [{ element_index: 4, correct_tag: 'P' }] };
  const pred = { status: 'fail', findings: [{ element_index: 4, correct_tag: 'H2' }] };
  const row = scoreOne('heading', gold, pred, 'fixture-5');
  assert.equal(row.exactCorrections, false);
});

test('scoreOne: validJson reflects whether pred parsed (not gold)', () => {
  const gold = { status: 'pass', findings: [] };
  const row = scoreOne('table', gold, null, 'fixture-6');
  assert.equal(row.validJson, false);
  // With no parsed prediction, predStatus is null and can never match gold.
  assert.equal(row.predStatus, null);
  assert.equal(row.statusMatch, false);
});

// ---------------------------------------------------------------------------
// summarize (§0.9)
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<RowScore>): RowScore {
  return {
    fixtureId: 'f',
    task: 'heading',
    validJson: true,
    goldStatus: 'pass',
    predStatus: 'pass',
    statusMatch: true,
    passFalsePositive: false,
    ...overrides,
  };
}

test('summarize: exactCorrectionAccuracy is computed over gold-fail rows only', () => {
  const rows: RowScore[] = [
    // pass row: exactCorrections trivially true, must NOT count toward the average.
    makeRow({ fixtureId: 'p1', goldStatus: 'pass', predStatus: 'pass', statusMatch: true, exactCorrections: true }),
    // fail rows: one exact match, one miss.
    makeRow({ fixtureId: 'f1', goldStatus: 'fail', predStatus: 'fail', statusMatch: true, exactCorrections: true }),
    makeRow({ fixtureId: 'f2', goldStatus: 'fail', predStatus: 'fail', statusMatch: true, exactCorrections: false }),
  ];
  const metrics = summarize('heading', 'adapter:remedy-heading-v1', rows, [100, 200, 300]);
  assert.equal(metrics.exactCorrectionAccuracy, 0.5);
});

test('summarize: nearThresholdStatusAccuracy is null when no rows are near-threshold', () => {
  const rows: RowScore[] = [
    makeRow({ task: 'contrast', fixtureId: 'c1', nearThreshold: false }),
    makeRow({ task: 'contrast', fixtureId: 'c2', nearThreshold: false }),
  ];
  const metrics = summarize('contrast', 'base', rows, [50, 60]);
  assert.equal(metrics.nearThresholdStatusAccuracy, null);
});

test('summarize: nearThresholdStatusAccuracy averages statusMatch over near-threshold rows only', () => {
  const rows: RowScore[] = [
    makeRow({ task: 'contrast', fixtureId: 'c1', nearThreshold: true, statusMatch: true }),
    makeRow({ task: 'contrast', fixtureId: 'c2', nearThreshold: true, statusMatch: false }),
    makeRow({ task: 'contrast', fixtureId: 'c3', nearThreshold: false, statusMatch: false }),
  ];
  const metrics = summarize('contrast', 'base', rows, [10, 20, 30]);
  assert.equal(metrics.nearThresholdStatusAccuracy, 0.5);
});

test('summarize: a failing gate is reported with passed=false (statusAccuracy below the table gate)', () => {
  // table's gate requires statusAccuracy >= 1.00 (the only perfect-accuracy gate).
  const rows: RowScore[] = [
    makeRow({ task: 'table', fixtureId: 't1', statusMatch: true }),
    makeRow({ task: 'table', fixtureId: 't2', statusMatch: false }),
  ];
  const metrics = summarize('table', 'generalist:gemma4:e2b', rows, [100, 100]);
  assert.equal(metrics.statusAccuracy, 0.5);
  const statusGate = metrics.gates.find((g) => g.name === 'statusAccuracy');
  assert.ok(statusGate);
  assert.equal(statusGate!.passed, false);
  assert.equal(statusGate!.observed, 0.5);
});

test('summarize: a gate over null observed data (no fail rows) is passed=false, not silently passing', () => {
  const rows: RowScore[] = [
    makeRow({ task: 'heading', fixtureId: 'h1', goldStatus: 'pass', predStatus: 'pass', statusMatch: true }),
  ];
  const metrics = summarize('heading', 'base', rows, [10]);
  assert.equal(metrics.exactCorrectionAccuracy, null);
  const correctionGate = metrics.gates.find((g) => g.name === 'exactCorrectionAccuracy');
  assert.ok(correctionGate);
  assert.equal(correctionGate!.observed, null);
  assert.equal(correctionGate!.passed, false);
});

test('summarize: validJsonRate/statusAccuracy/passFalsePositiveRate are plain means over all rows, rounded 4dp', () => {
  const rows: RowScore[] = [
    makeRow({ fixtureId: 'a', validJson: true, statusMatch: true, passFalsePositive: false }),
    makeRow({ fixtureId: 'b', validJson: true, statusMatch: false, passFalsePositive: true }),
    makeRow({ fixtureId: 'c', validJson: false, statusMatch: false, passFalsePositive: false, goldStatus: null, predStatus: null }),
  ];
  const metrics = summarize('heading', 'base', rows, [1, 2, 3]);
  assert.equal(metrics.validJsonRate, round4(2 / 3));
  assert.equal(metrics.statusAccuracy, round4(1 / 3));
  assert.equal(metrics.passFalsePositiveRate, round4(1 / 3));
  assert.equal(metrics.medianLatencyMs, 2);
});

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

test('summarize: confusion counts gold->pred pairs, including a null gold status', () => {
  const rows: RowScore[] = [
    makeRow({ fixtureId: 'a', goldStatus: 'pass', predStatus: 'pass' }),
    makeRow({ fixtureId: 'b', goldStatus: 'pass', predStatus: 'fail' }),
    makeRow({ fixtureId: 'c', goldStatus: null, predStatus: 'fail' }),
  ];
  const metrics = summarize('heading', 'base', rows, [1, 1, 1]);
  assert.equal(metrics.confusion['pass->pass'], 1);
  assert.equal(metrics.confusion['pass->fail'], 1);
  assert.equal(metrics.confusion['null->fail'], 1);
});

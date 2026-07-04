import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogSummaryLabel, catalogPromptLines } from './catalog-view.js';
import type { CatalogCourse, CatalogCourseSummary } from '../../contracts/index.js';

test('catalogSummaryLabel includes the college parenthetical when present', () => {
  const summary: CatalogCourseSummary = { id: 38409, code: 'ACCTG001', title: 'Introductory Accounting I', college: 'wlac.elumenapp.com' };
  assert.equal(catalogSummaryLabel(summary), 'ACCTG001 — Introductory Accounting I (wlac.elumenapp.com)');
});

test('catalogSummaryLabel omits the parenthetical when college is undefined', () => {
  const summary: CatalogCourseSummary = { id: 1, code: 'MATH101', title: 'College Algebra' };
  assert.equal(catalogSummaryLabel(summary), 'MATH101 — College Algebra');
});

test('catalogPromptLines returns [] when no course is selected', () => {
  assert.deepEqual(catalogPromptLines(undefined), []);
});

test('catalogPromptLines emits header, SLO lines, and a description line', () => {
  const course: CatalogCourse = {
    id: 1,
    code: 'ACCTG001',
    title: 'Introductory Accounting I',
    slos: ['Prepare basic financial statements.', 'Apply the accounting cycle.'],
    objectives: [],
    description: 'An introduction to financial accounting principles.',
    source: 'mirror',
  };
  assert.deepEqual(catalogPromptLines(course), [
    'Official course outcomes (LACCD catalog, ACCTG001):',
    '- Prepare basic financial statements.',
    '- Apply the accounting cycle.',
    'Official course description: An introduction to financial accounting principles.',
  ]);
});

test('catalogPromptLines omits the description line when description is absent', () => {
  const course: CatalogCourse = {
    id: 2,
    code: 'MATH101',
    title: 'College Algebra',
    slos: ['Solve polynomial equations.'],
    objectives: [],
    source: 'live',
  };
  assert.deepEqual(catalogPromptLines(course), [
    'Official course outcomes (LACCD catalog, MATH101):',
    '- Solve polynomial equations.',
  ]);
});

test('catalogPromptLines emits a "no outcomes on file" marker when slos is empty', () => {
  const course: CatalogCourse = {
    id: 3,
    code: 'PHIL201',
    title: 'Ethics',
    slos: [],
    objectives: [],
    source: 'mirror',
  };
  assert.deepEqual(catalogPromptLines(course), [
    'Official course outcomes (LACCD catalog, PHIL201):',
    '- [no outcomes on file]',
  ]);
});

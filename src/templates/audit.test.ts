/**
 * Real-engine audit of every BUILD template (SHIP-READINESS recommendation #8).
 *
 * `render.test.ts` validates the 8 templates against the ALLOWLIST only. This runs
 * each fixture — plus a themed variant and the degenerate no-levels rubric — and a
 * styled-Canvas-shell fragment through the SAME render + axe `audit()` the output
 * gate enforces, asserting no blocker/error issue. That locks the core promise
 * "BUILD produces badge-passing artifacts" against the real auditor, not a proxy.
 *
 * Env-gated (needs a Chromium binary), like `src/engine/render/integration.test.ts`:
 *   RUN_BROWSER_INTEGRATION=1 npx tsx --test src/templates/audit.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditIssue, TemplateType, TemplateSlots, ThemeResult } from '../contracts/index.js';
import { renderTemplate } from './index.js';
import { createAuditor, createPlaywrightRunner } from '../engine/render/index.js';

const optedIn = ['1', 'true', 'yes'].includes((process.env.RUN_BROWSER_INTEGRATION ?? '').toLowerCase());
const skip: true | string | false = optedIn ? false : 'set RUN_BROWSER_INTEGRATION=1 to run';

// Small settle delay keeps the gated run fast; fragments load no network.
const audit = createAuditor(createPlaywrightRunner({ settleDelayMs: 50 }));

/** The two severities that withhold the badge (mirrors the gate's BLOCKING set). */
const gating = (issues: AuditIssue[]): AuditIssue[] =>
  issues.filter((i) => i.severity === 'blocker' || i.severity === 'error');

const FIXTURES: Record<TemplateType, TemplateSlots> = {
  syllabus: {
    title: 'Intro to Astronomy',
    instructor: 'Dr. Vega',
    description: 'A one-semester survey of the night sky.',
    schedule: ['Week 1: Orientation', 'Week 2: The Moon & tides'],
    policies: ['Late work loses 10% per day.', 'Be respectful in discussions.'],
  },
  'module-overview': {
    title: 'Module 1: Foundations',
    objectives: ['Define key terms', 'Explain the scientific method'],
    items: ['Read chapter 1', 'Watch the intro video', 'Post to the discussion'],
  },
  assignment: {
    title: 'Essay 1: Argument',
    overview: 'Write a 1000-word argumentative essay.',
    instructions: ['Pick a topic', 'Draft a thesis', 'Submit a PDF'],
    dueDate: '2026-09-15',
    points: 100,
    rubricRef: 'Writing Rubric',
  },
  discussion: {
    title: 'Week 1 Discussion',
    prompt: 'What surprised you about the reading?',
    guidelines: ['Cite the text', 'Reply to two peers'],
    expectations: 'Initial post by Wednesday; replies by Friday.',
  },
  'page-content': {
    title: 'Course Resources',
    sections: [
      { heading: 'Library', body: 'Visit the library portal for databases.' },
      { heading: 'Tutoring', body: 'Drop-in hours are available daily.' },
    ],
  },
  'lecture-notes': {
    title: 'Lecture 3: Photosynthesis',
    topics: [
      { heading: 'Light reactions', points: ['Occur in the thylakoid', 'Produce ATP & NADPH'] },
      { heading: 'Calvin cycle', points: ['Fixes carbon', 'Produces glucose'] },
    ],
  },
  'study-guide': {
    title: 'Midterm Study Guide',
    keyTerms: [
      { term: 'Mitosis', definition: 'Division producing two identical cells.' },
      { term: 'Meiosis', definition: 'Division producing gametes.' },
    ],
    questions: ['Compare mitosis and meiosis.', 'Describe the phases of the cell cycle.'],
  },
  rubric: {
    title: 'Essay Rubric',
    criteria: [
      {
        name: 'Thesis',
        levels: [
          { label: 'Excellent', points: 10, descriptor: 'Clear, arguable thesis.' },
          { label: 'Adequate', points: 6, descriptor: 'Thesis present but vague.' },
          { label: 'Poor', points: 2, descriptor: 'No discernible thesis.' },
        ],
      },
    ],
  },
};

const THEME: ThemeResult = {
  colors: [
    {
      role: 'heading',
      background: '#0b3d91',
      foreground: '#ffffff',
      contrast: { ratio: 12.5, level: 'AAA', passesAA: true, passesAAA: true, size: 'normal' },
    },
    {
      role: 'accent',
      background: '#fff4e5',
      foreground: '#5a3b00',
      contrast: { ratio: 8.1, level: 'AAA', passesAA: true, passesAAA: true, size: 'normal' },
    },
  ],
  warnings: [],
};

for (const type of Object.keys(FIXTURES) as TemplateType[]) {
  test(`BUILD template "${type}" passes the real render+axe audit (no blocker/error)`, { skip }, async () => {
    const { html } = await renderTemplate(type, FIXTURES[type]);
    const { issues } = await audit(html);
    const blocking = gating(issues);
    assert.equal(blocking.length, 0, `${type}: ${JSON.stringify(blocking)}`);
  });
}

test('themed assignment passes the real audit (brand colors stay AA)', { skip }, async () => {
  const { html } = await renderTemplate('assignment', FIXTURES.assignment, THEME);
  const { issues } = await audit(html);
  assert.equal(gating(issues).length, 0, JSON.stringify(gating(issues)));
});

test('the degenerate no-levels rubric (Details-column path) passes the real audit', { skip }, async () => {
  const noLevels: TemplateSlots = { title: 'Participation Rubric', criteria: [{ name: 'Participation', levels: [] }] };
  const { html } = await renderTemplate('rubric', noLevels);
  const { issues } = await audit(html);
  assert.equal(gating(issues).length, 0, JSON.stringify(gating(issues)));
});

test('default Canvas-shell colors: styled link/button/th/blockquote yield no contrast blocker', { skip }, async () => {
  // Guards future shell-color edits: the audit wraps fragments in the Canvas shell,
  // so this exercises the shell's link/button/th/blockquote default pairs.
  const html =
    '<h2>Heading</h2>' +
    '<p>Body with a <a href="https://example.com">link</a>.</p>' +
    '<p><button type="button">Button</button></p>' +
    '<blockquote>A quoted passage used to check blockquote contrast.</blockquote>' +
    '<table><thead><tr><th scope="col">Header</th></tr></thead><tbody><tr><td>Cell</td></tr></tbody></table>';
  const { issues } = await audit(html);
  const contrastBlockers = issues.filter(
    (i) => i.category === 'contrast' && (i.severity === 'blocker' || i.severity === 'error'),
  );
  assert.equal(contrastBlockers.length, 0, `unexpected contrast blockers: ${JSON.stringify(contrastBlockers)}`);
});

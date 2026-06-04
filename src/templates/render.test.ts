import test from 'node:test';
import assert from 'node:assert/strict';

import type { TemplateType, TemplateSlots, ThemeResult } from '../contracts/index.js';
import { validateAllowlist } from '../engine/index.js';
import { renderTemplate } from './index.js';

const TYPES: TemplateType[] = [
  'syllabus',
  'module-overview',
  'assignment',
  'discussion',
  'page-content',
  'lecture-notes',
  'study-guide',
  'rubric',
];

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
      {
        name: 'Evidence',
        levels: [
          { label: 'Excellent', points: 10, descriptor: 'Specific, cited evidence.' },
          { label: 'Adequate', points: 6, descriptor: 'Some supporting evidence.' },
          { label: 'Poor', points: 2, descriptor: 'Little or no evidence.' },
        ],
      },
    ],
  },
};

test('every template type renders non-empty, allowlist-stable HTML', async () => {
  for (const type of TYPES) {
    const result = await renderTemplate(type, FIXTURES[type]);
    assert.equal(result.type, type, `${type}: wrong type echoed`);
    assert.ok(result.html.length > 0, `${type}: empty html`);
    assert.ok(Array.isArray(result.warnings), `${type}: warnings not an array`);

    const validated = await validateAllowlist(result.html);
    assert.deepEqual(validated.removedSemantic, [], `${type}: removed semantic elements`);
    assert.equal(validated.html, result.html, `${type}: html not allowlist-stable`);
  }
});

test('every fragment has exactly one top heading (h2-equivalent) and no h1', async () => {
  for (const type of TYPES) {
    const { html } = await renderTemplate(type, FIXTURES[type]);
    const h2s = html.match(/<h2[\s>]/g) ?? [];
    assert.equal(h2s.length, 1, `${type}: expected exactly one <h2>, got ${h2s.length}`);
    assert.ok(!/<h1[\s>]/.test(html), `${type}: must not emit <h1>`);
  }
});

test('rubric renders an accessible <table> with scoped column and row headers', async () => {
  const { html } = await renderTemplate('rubric', FIXTURES.rubric);
  assert.match(html, /<table[\s>]/);
  assert.match(html, /<th scope="col">/);
  assert.match(html, /<th scope="row">/);
  // Header cells include the title column and each performance level.
  assert.ok(html.includes('Excellent'));
  assert.ok(html.includes('Adequate'));
});

test('a provided theme applies its ResolvedColors and stays allowlist-safe', async () => {
  const theme: ThemeResult = {
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

  const { html } = await renderTemplate('assignment', FIXTURES.assignment, theme);
  // Heading band uses the heading role pair; the meta callout uses the accent pair.
  assert.ok(html.includes('#0b3d91'), 'heading background missing');
  assert.ok(html.includes('#ffffff'), 'heading foreground missing');
  assert.ok(html.includes('#fff4e5'), 'accent background missing');
  assert.ok(html.includes('#5a3b00'), 'accent foreground missing');

  const validated = await validateAllowlist(html);
  assert.deepEqual(validated.removedSemantic, []);
  assert.equal(validated.html, html, 'themed html not allowlist-stable');
});

test('without a theme, no colors are emitted (safe defaults)', async () => {
  const { html } = await renderTemplate('syllabus', FIXTURES.syllabus);
  assert.ok(!/color\s*:/.test(html), 'unthemed output should not emit color declarations');
});

test('missing optional slots produce warnings instead of throwing', async () => {
  const result = await renderTemplate('module-overview', { title: 'Module 1' });
  assert.ok(result.warnings.length > 0, 'expected warnings for omitted sections');
  assert.ok(result.html.includes('Module 1'), 'title should still render');
  // Still valid, stable HTML.
  const validated = await validateAllowlist(result.html);
  assert.equal(validated.html, result.html);
  assert.deepEqual(validated.removedSemantic, []);
});

test('a missing required title warns and falls back to a placeholder heading', async () => {
  const result = await renderTemplate('page-content', {
    sections: [{ heading: 'Intro', body: 'Hello' }],
  });
  assert.ok(result.warnings.some((w) => /title/i.test(w)), 'expected a title warning');
  assert.ok(result.html.includes('Untitled'), 'expected a placeholder heading');
});

test('user content with <, &, and " is escaped and round-trips through the allowlist', async () => {
  const result = await renderTemplate('page-content', {
    title: 'A & B < C',
    sections: [{ heading: 'Q "quoted"', body: 'if x < y && y > 0 then ok' }],
  });
  assert.ok(result.html.includes('&amp;'), 'ampersand not escaped');
  assert.ok(result.html.includes('&lt;'), 'less-than not escaped');
  assert.ok(!/<C/.test(result.html), 'raw "<C" leaked into markup');

  const validated = await validateAllowlist(result.html);
  assert.equal(validated.html, result.html, 'escaped content not stable');
  assert.deepEqual(validated.removedSemantic, []);
});

test('an unsupported template type is reported, not thrown', async () => {
  // Defensive: a bad type from an untyped caller should not crash the gate.
  const result = await renderTemplate('does-not-exist' as TemplateType, {});
  assert.ok(result.warnings.length > 0);
  const validated = await validateAllowlist(result.html);
  assert.equal(validated.html, result.html);
  assert.deepEqual(validated.removedSemantic, []);
});

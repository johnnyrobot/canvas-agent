import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeAlignmentPrompt } from './alignment.js';

// Pure prompt composition — no DOM. (createAlignment's panel wiring is covered by
// the renderer DOM-harness tests.)

test('includes provided objectives + rubric (trimmed) under their labels, content last', () => {
  const p = composeAlignmentPrompt({
    content: '  Course content here  ',
    objectives: '  Obj A\nObj B  ',
    rubric: '  Crit 1  ',
  });
  assert.match(p, /Learning objectives:\nObj A\nObj B/);
  assert.match(p, /Rubric criteria:\nCrit 1/);
  assert.match(p, /Content:\nCourse content here$/, 'trimmed content is the final block');
});

test('omitted objectives/rubric fall back to the infer placeholders', () => {
  const p = composeAlignmentPrompt({ content: 'X' });
  assert.match(p, /infer the likely objectives/);
  assert.match(p, /infer reasonable rubric criteria/);
});

test('whitespace-only objectives/rubric are treated as omitted (not pasted blank)', () => {
  const p = composeAlignmentPrompt({ content: 'X', objectives: '   ', rubric: '\n\t ' });
  assert.match(p, /infer the likely objectives/);
  assert.match(p, /infer reasonable rubric criteria/);
});

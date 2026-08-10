/**
 * Unit tests for the deterministic floor. Fully offline — no model, no network.
 *
 * Every test states the harm the rule prevents, because a floor rule that
 * nobody can justify is a rule that gets relaxed the first time it blocks a
 * release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFloor, maxConsecutiveRepeats, summarise, MAX_ALT_CHARS } from './floor.ts';
import { ALT_FIXTURES, type AltFixture } from './fixtures.ts';

const fixture = (over: Partial<AltFixture> = {}): AltFixture => ({
  id: 'f1',
  category: 'chart',
  html: '<p>x</p>',
  context: 'ctx',
  referenceAlt: 'ref',
  rationale: 'r',
  ...over,
});

const rules = (f: AltFixture, s: string): string[] => checkFloor(f, s).violations.map((v) => v.rule);

test('an informative image with no alternative fails', () => {
  assert.deepEqual(rules(fixture(), '   '), ['empty']);
  assert.equal(checkFloor(fixture(), '').passed, false);
});

test('"image of" boilerplate fails — the screen reader already said "image"', () => {
  for (const s of [
    'Image of a bar chart showing enrollment',
    'a picture of the campus map',
    'Screenshot showing the gradebook',
    'An illustration depicting a plant cell',
  ]) {
    assert.ok(rules(fixture(), s).includes('redundant-prefix'), `should flag: ${s}`);
  }
});

test('a description that merely CONTAINS the word image is not flagged', () => {
  // The rule is anchored at the start deliberately: "Diagram of the imaging
  // workflow" is fine, and a floor that fires on it would be relaxed within a week.
  assert.deepEqual(rules(fixture(), 'Bar chart of enrollment by quarter, rising from Q1 to Q4'), []);
  assert.ok(!rules(fixture(), 'Workflow for image processing, four steps').includes('redundant-prefix'));
});

test('a filename is not a text alternative', () => {
  assert.ok(rules(fixture(), 'chart_final_v2.png').includes('filename'));
  assert.ok(rules(fixture(), 'The chart from enrollment.PNG shows growth').includes('filename'));
});

test('over-long alt fails at the stated ceiling', () => {
  assert.deepEqual(rules(fixture(), 'a'.repeat(MAX_ALT_CHARS)), []);
  assert.ok(rules(fixture(), 'a'.repeat(MAX_ALT_CHARS + 1)).includes('too-long'));
});

test('a looping suggestion fails — the known failure mode of the provisional candidate', () => {
  const looped = 'The chart shows enrollment rising. The chart shows enrollment rising. The chart shows enrollment rising.';
  assert.ok(rules(fixture(), looped).includes('looping'));
  assert.equal(maxConsecutiveRepeats(looped), 3);
});

test('repetition detection ignores case, spacing and punctuation', () => {
  assert.equal(maxConsecutiveRepeats('A cell diagram; a  CELL   diagram.'), 2);
});

test('a genuinely varied description is not called looping', () => {
  const varied = 'Plant cell illustration. The nucleus is labelled at the centre. A chloroplast sits lower left.';
  assert.deepEqual(rules(fixture(), varied), []);
  assert.equal(maxConsecutiveRepeats(varied), 1);
});

test('text rendered in the image must be reproduced, or the model described without reading', () => {
  const scan = fixture({ category: 'text-in-image', mustMention: ['BIO 101', 'Room 214'] });

  // Plausible, fluent, and useless — it never read the page.
  const invented = 'A scanned syllabus document with several paragraphs of course information.';
  assert.deepEqual(rules(scan, invented), ['unread-content', 'unread-content']);

  const read = 'Scanned BIO 101 syllabus: office hours Tuesday 2:00-4:00 in Room 214.';
  assert.deepEqual(rules(scan, read), []);
});

test('required text is matched case-insensitively, so casing is not a false failure', () => {
  const scan = fixture({ category: 'text-in-image', mustMention: ['Grades'] });
  assert.deepEqual(rules(scan, 'Canvas navigation with grades highlighted'), []);
});

test('required text is matched ignoring SPACING — the bug the first live run exposed', () => {
  // The provisional candidate read the syllabus perfectly and emitted "Room214".
  // The gate called that unread content and reported FAIL on a model that had
  // done the hard part correctly. Spacing is a formatting complaint; this rule
  // asks only whether the pixels were read.
  const scan = fixture({ category: 'text-in-image', mustMention: ['Room 214', 'October 14'] });
  assert.deepEqual(rules(scan, 'BIO 101 syllabus. Office hours Tuesday2:00–4:00,Room214 Midterm exam:October14'), []);
});

test('a decorative image must get an EMPTY alternative', () => {
  const deco = fixture({ category: 'decorative', referenceAlt: '' });
  assert.equal(checkFloor(deco, '').passed, true);
  assert.equal(checkFloor(deco, '  ').passed, true);
  assert.ok(rules(deco, 'A dashed horizontal divider line').includes('decorative-narrated'));
});

test('a decorative image is exempt from every other rule', () => {
  // Empty would otherwise trip `empty`; this ordering is the whole reason the
  // decorative branch returns early.
  const deco = fixture({ category: 'decorative' });
  assert.deepEqual(checkFloor(deco, '').violations, []);
});

test('CORPUS INTEGRITY: no required string appears in its own context', () => {
  // The first live run passed two fixtures vacuously. The model echoed the
  // context sentence back verbatim as its "alt text", and that echo happened to
  // contain the very words `mustMention` was checking for — so the rule that
  // exists to prove the model READ THE IMAGE was satisfied by parroting the
  // prompt. A required string leaking into the context silently disarms the only
  // teeth this gate has.
  const leaks: string[] = [];
  for (const f of ALT_FIXTURES) {
    const context = f.context.toLowerCase().replace(/\s+/g, '');
    for (const required of f.mustMention ?? []) {
      if (context.includes(required.toLowerCase().replace(/\s+/g, ''))) {
        leaks.push(`${f.id}: ${JSON.stringify(required)} is already in its context`);
      }
    }
  }
  assert.deepEqual(leaks, [], 'a required string must be readable ONLY from the pixels');
});

test('CORPUS INTEGRITY: every text-in-image fixture actually declares required text', () => {
  for (const f of ALT_FIXTURES.filter((x) => x.category === 'text-in-image')) {
    assert.ok((f.mustMention?.length ?? 0) > 0, `${f.id} must declare mustMention or it proves nothing`);
  }
});

test('the floor is all-or-nothing across the corpus', () => {
  const pass = { fixtureId: 'a', suggestion: 'x', violations: [], passed: true };
  const fail = { fixtureId: 'b', suggestion: '', violations: [{ rule: 'empty', detail: 'd' }], passed: false };

  assert.equal(summarise([pass, pass]).passed, true);
  const s = summarise([pass, fail]);
  assert.equal(s.passed, false, 'nine good answers must not average away one harmful one');
  assert.deepEqual(s.failedFixtures, ['b']);
  assert.deepEqual(s.ruleCounts, { empty: 1 });
});

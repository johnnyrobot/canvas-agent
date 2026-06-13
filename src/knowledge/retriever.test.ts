import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRetriever, RUBRIC_ID_PATTERN } from './retriever.js';
import type { KnowledgePack } from './pack.js';

const PACKS_DIR = fileURLToPath(new URL('./packs', import.meta.url));

const packA: KnowledgePack = {
  id: 'packA',
  title: 'Pack A',
  intents: ['accessibility'],
  units: [
    {
      id: 'contrast',
      heading: 'Color contrast',
      text: 'Body text must have a contrast ratio of at least 4.5 to 1 against its background.',
      citation: 'WCAG 2.2 §1.4.3',
    },
    {
      id: 'alt-text',
      heading: 'Alternative text',
      text: 'Meaningful images need descriptive alternative text for screen reader users.',
      citation: 'WCAG 2.2 §1.1.1',
    },
  ],
};

const packB: KnowledgePack = {
  id: 'packB',
  title: 'Pack B',
  intents: ['templates'],
  units: [
    {
      id: 'module-overview',
      heading: 'Module overview',
      text: 'A module overview page lists the learning objectives and a summary of topics.',
      citation: 'Canvas Template Guide §2',
    },
    {
      id: 'RUB-3',
      heading: 'Thesis criterion',
      text: 'The submission states a clear, arguable thesis in the opening paragraph.',
      citation: 'Rubric Library §RUB-3',
    },
  ],
};

function retriever() {
  return createRetriever({ packs: [packA, packB] });
}

test('RUBRIC_ID_PATTERN matches rubric/criterion ids and rejects prose', () => {
  assert.ok(RUBRIC_ID_PATTERN.test('RUB-3'));
  assert.ok(RUBRIC_ID_PATTERN.test('A11Y-12'));
  assert.ok(RUBRIC_ID_PATTERN.test('R7'));
  assert.ok(!RUBRIC_ID_PATTERN.test('color contrast'));
  assert.ok(!RUBRIC_ID_PATTERN.test('1.4.3'));
});

test('morphological queries match via stemming (C9)', async () => {
  // packA/alt-text says "images" (plural); a singular query must still match.
  const retrieve = createRetriever({ packs: [packA] });
  const { hits } = await retrieve('image');
  assert.ok(
    hits.some((h) => h.id === 'packA:alt-text'),
    'singular "image" should match the unit that says "images"',
  );
});

test('a WCAG criterion number in a citation is searchable (C9)', async () => {
  // The criterion digits appear ONLY in the citation; the body has no digits,
  // so a hit proves the citation column is indexed.
  const citePack: KnowledgePack = {
    id: 'cite',
    title: 'Cite',
    intents: ['accessibility'],
    units: [
      {
        id: 'auth',
        heading: 'Accessible authentication',
        text: 'Do not require a cognitive function memory puzzle to sign in.',
        citation: 'WCAG 2.2 §3.3.8',
      },
    ],
  };
  const retrieve = createRetriever({ packs: [citePack] });
  const { hits } = await retrieve('3.3.8');
  assert.ok(hits.length > 0, 'criterion-number lookup should hit the unit via its citation');
  assert.equal(hits[0]?.id, 'cite:auth');
});

test('a query clearly matching one unit ranks it first', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('color contrast ratio');
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.packId, 'packA');
  assert.equal(hits[0]?.title, 'Pack A');
  assert.ok(hits[0]?.id.includes('contrast'));
});

test('scores are positive and sorted descending (higher = more relevant)', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('text image background overview');
  assert.ok(hits.length >= 2);
  for (const hit of hits) assert.ok(hit.score > 0, 'score should be positive');
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i - 1]!.score >= hits[i]!.score, 'hits must be sorted by descending score');
  }
});

test('pack scoping never returns hits from an unscoped pack', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('overview objectives summary contrast', ['packB']);
  assert.ok(hits.length > 0);
  for (const hit of hits) assert.equal(hit.packId, 'packB');
});

test('scoping to an unknown pack yields no hits', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('contrast', ['does-not-exist']);
  assert.deepEqual(hits, []);
});

test('every hit carries the correct citation from its unit', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('contrast');
  assert.ok(hits.length > 0);
  const top = hits[0]!;
  assert.equal(top.citation, 'WCAG 2.2 §1.4.3');
  for (const hit of hits) assert.ok(hit.citation.length > 0);
});

test('the snippet contains the matched unit text', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('contrast ratio');
  assert.ok(hits[0]?.snippet.includes('4.5 to 1'));
});

test('rubric-ID routing returns the exact unit and short-circuits FTS', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('RUB-3');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.packId, 'packB');
  assert.ok(hits[0]?.id.includes('RUB-3'));
  assert.equal(hits[0]?.citation, 'Rubric Library §RUB-3');
});

test('rubric-ID routing is case-insensitive', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('rub-3');
  assert.equal(hits.length, 1);
  assert.ok(hits[0]?.id.includes('RUB-3'));
});

test('an unknown rubric id falls back to FTS and finds nothing here', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('ZZ-99');
  assert.deepEqual(hits, []);
});

test('a query full of FTS special characters does not throw', async () => {
  const retrieve = retriever();
  const { hits } = await retrieve('contrast "ratio" * OR background: (4.5)');
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.packId, 'packA');
});

test('empty and whitespace-only queries return no hits', async () => {
  const retrieve = retriever();
  assert.deepEqual((await retrieve('')).hits, []);
  assert.deepEqual((await retrieve('   ')).hits, []);
  assert.deepEqual((await retrieve('"*:()')).hits, []);
});

test('a no-match query returns an empty result', async () => {
  const retrieve = retriever();
  assert.deepEqual((await retrieve('xylophone quasar nonexistentterm')).hits, []);
});

test('limit caps the number of returned hits', async () => {
  const retrieve = createRetriever({ packs: [packA, packB], limit: 1 });
  const { hits } = await retrieve('text overview image objectives');
  assert.equal(hits.length, 1);
});

test('createRetriever() with no options loads the bundled packs', async () => {
  const retrieve = createRetriever();
  const { hits } = await retrieve('color contrast ratio');
  assert.ok(hits.length > 0);
  assert.ok(hits.some((h) => h.packId === 'wcag-basics'));
});

test('createRetriever({ dir }) loads packs from a directory', async () => {
  const retrieve = createRetriever({ dir: PACKS_DIR });
  const { hits } = await retrieve('syllabus grading materials');
  assert.ok(hits.length > 0);
  assert.ok(hits.some((h) => h.packId === 'canvas-templates'));
});

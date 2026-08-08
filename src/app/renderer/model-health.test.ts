import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeHealth } from '../../contracts/index.js';
import {
  MODEL_DOWNLOAD_SIZES_GB,
  advanceModelPull,
  downloadModelAffordance,
  missingRequiredModels,
  missingModelsText,
  requiredTagsFromHealth,
  startModelPull,
} from './model-health.js';

const model = (tag: string, available: boolean) => ({ tag, available, installCommand: `ollama pull ${tag}` });

test('a missing VISION model is reported as missing even when the text model is present', () => {
  // The bug this prevents: first run pulls the text model, the screen dismisses,
  // and alt-text suggestion fails later on a machine that read as fully ready.
  const health: RuntimeHealth = {
    llm: true,
    ingest: true,
    model: model('text:1b', true),
    visionModel: model('vision:2b', false),
  };
  assert.deepEqual(
    missingRequiredModels(health).map((m) => m.tag),
    ['vision:2b'],
  );
  assert.match(missingModelsText(missingRequiredModels(health)), /vision:2b/);
});

test('a missing TEXT model is still reported (the pre-existing behaviour)', () => {
  const health: RuntimeHealth = { llm: true, ingest: true, model: model('text:1b', false) };
  assert.deepEqual(
    missingRequiredModels(health).map((m) => m.tag),
    ['text:1b'],
  );
});

test('both missing are reported in role order, text first', () => {
  const health: RuntimeHealth = {
    llm: true,
    ingest: true,
    model: model('text:1b', false),
    visionModel: model('vision:2b', false),
  };
  assert.deepEqual(
    missingRequiredModels(health).map((m) => m.tag),
    ['text:1b', 'vision:2b'],
  );
  assert.match(missingModelsText(missingRequiredModels(health)), /text:1b.*vision:2b/);
});

test('a tag shared by both roles is listed once', () => {
  // Today's defaults: `vision` inherits the text model — two required roles, one
  // download. Naming it twice would read as two downloads to the user.
  const health: RuntimeHealth = {
    llm: true,
    ingest: true,
    model: model('shared:8b', false),
    visionModel: model('shared:8b', false),
  };
  assert.deepEqual(
    missingRequiredModels(health).map((m) => m.tag),
    ['shared:8b'],
  );
});

test('nothing is missing when both required models are present', () => {
  const health: RuntimeHealth = {
    llm: true,
    ingest: true,
    model: model('text:1b', true),
    visionModel: model('vision:2b', true),
  };
  assert.deepEqual(missingRequiredModels(health), []);
  assert.equal(missingModelsText([]), '');
});

test('the download affordance names every model it will fetch, and agrees with itself on number', () => {
  const one = downloadModelAffordance([model('vision:2b', false)]);
  assert.equal(one.text, 'Download model');
  assert.equal(one.label, 'Download model vision:2b');

  // The button pulls the whole required set, so its accessible name must list
  // both — a name saying "model" while fetching two misdescribes the action.
  const two = downloadModelAffordance([model('text:1b', false), model('vision:2b', false)]);
  assert.equal(two.text, 'Download models');
  assert.match(two.label, /text:1b/);
  assert.match(two.label, /vision:2b/);
});

test('a model the runtime cannot report is not invented as missing', () => {
  // `unavailable-api` omits both fields: absent means "cannot report", and the
  // runtime is already degraded on `llm`/`ingest` in that case.
  assert.deepEqual(missingRequiredModels({}), []);
});

// ── What the user is told BEFORE committing to the download (issue #32) ──────

const SIZES = { 'text:1b': 5.3, 'vision:2b': 3.3 };

test('the download size is stated before it starts, summed across both models', () => {
  const both = downloadModelAffordance([model('text:1b', false), model('vision:2b', false)], SIZES);
  assert.equal(both.sizeText, 'About 8.6 GB to download');
  // The accessible name carries it too, so the size is not sighted-only.
  assert.match(both.label, /8\.6 GB/);
});

test('one missing model is sized on its own, not on the whole required set', () => {
  const one = downloadModelAffordance([model('vision:2b', false)], SIZES);
  assert.equal(one.sizeText, 'About 3.3 GB to download');
});

test('an undeclared model size is never invented — the stated total stays a floor', () => {
  // A tag with no declared size (e.g. an administrator's own model) must not be
  // silently counted as 0 GB: that would understate the wait, which is the exact
  // failure this copy exists to fix.
  const mixed = downloadModelAffordance([model('text:1b', false), model('mystery:70b', false)], SIZES);
  assert.equal(mixed.sizeText, 'More than 5.3 GB to download');
  assert.match(mixed.label, /more than 5\.3 GB/);
});

test('with no declared size at all the app claims no number and no parenthetical', () => {
  const unknown = downloadModelAffordance([model('mystery:70b', false)], SIZES);
  assert.equal(unknown.sizeText, '');
  assert.equal(unknown.label, 'Download model mystery:70b');
});

test('the shipped text default declares its download size', () => {
  // Paired with the guard in `src/runtime/deps.test.ts`: a shipped default tag
  // with no declared size would silently degrade the first-run copy to "More
  // than …" instead of failing loudly.
  assert.equal(MODEL_DOWNLOAD_SIZES_GB['granite4.1:8b'], 5.3);
  assert.equal(
    downloadModelAffordance([model('granite4.1:8b', false)]).sizeText,
    'About 5.3 GB to download',
  );
});

// ── The required set the download will cover ────────────────────────────────

test('the required tags are the text and vision tags, deduplicated in role order', () => {
  assert.deepEqual(
    requiredTagsFromHealth({ model: model('text:1b', true), visionModel: model('vision:2b', false) }),
    ['text:1b', 'vision:2b'],
  );
  assert.deepEqual(
    requiredTagsFromHealth({ model: model('shared:8b', true), visionModel: model('shared:8b', true) }),
    ['shared:8b'],
  );
  assert.deepEqual(requiredTagsFromHealth({}), []);
});

// ── One bar across both models (ADR-0009: a reset reads as a restart) ────────

test('aggregate progress never resets when the second model starts', () => {
  let pull = startModelPull(['text:1b', 'vision:2b']);
  const seen: number[] = [];
  const feed = (p: Parameters<typeof advanceModelPull>[1]): void => {
    pull = advanceModelPull(pull, p);
    seen.push(pull.percent);
  };

  feed({ status: 'pulling manifest', model: 'text:1b' });
  feed({ status: 'downloading', model: 'text:1b', percent: 50 });
  feed({ status: 'downloading', model: 'text:1b', percent: 100 });
  feed({ status: 'success', model: 'text:1b' });
  const afterFirstModel = pull.percent;
  // The second model starts at 0% of ITS OWN download — the bar must not follow.
  feed({ status: 'pulling manifest', model: 'vision:2b' });
  feed({ status: 'downloading', model: 'vision:2b', percent: 1 });

  assert.equal(afterFirstModel, 50, 'one of two models done is half the whole download');
  assert.ok(
    pull.percent >= afterFirstModel,
    `bar reset on the second model: ${seen.join(' → ')}`,
  );
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i]! >= seen[i - 1]!, `progress decreased at step ${i}: ${seen.join(' → ')}`);
  }
});

test("a finished model reports as downloaded; only the last one is 'Finishing…'", () => {
  // `success` arrives once per MODEL. Reading the first one as the end of the
  // pull is the same mistake as resetting the bar — it tells the user the wait
  // is over while a second multi-gigabyte transfer is about to start.
  let pull = startModelPull(['text:1b', 'vision:2b']);
  pull = advanceModelPull(pull, { status: 'success', model: 'text:1b' });
  assert.equal(pull.text, 'Downloaded text:1b (model 1 of 2)');
  pull = advanceModelPull(pull, { status: 'success', model: 'vision:2b' });
  assert.equal(pull.text, 'Finishing…');
});

test('the model currently transferring is named in the progress line', () => {
  let pull = startModelPull(['text:1b', 'vision:2b']);
  pull = advanceModelPull(pull, { status: 'downloading', model: 'vision:2b', percent: 12 });
  assert.match(pull.text, /vision:2b/, 'a long pause on a large file must not look like a hang');
});

test("a per-layer percent that restarts inside one model doesn't move the bar backwards", () => {
  // Ollama reports bytes for the LAYER currently transferring, so `percent`
  // legitimately drops to near-zero when the next layer of the SAME model starts.
  let pull = startModelPull(['solo:8b']);
  pull = advanceModelPull(pull, { status: 'downloading', model: 'solo:8b', percent: 90 });
  const high = pull.percent;
  pull = advanceModelPull(pull, { status: 'downloading', model: 'solo:8b', percent: 2 });
  assert.equal(pull.percent, high);
});

test('the aggregate reaches 100 only once every model has finished', () => {
  let pull = startModelPull(['text:1b', 'vision:2b']);
  pull = advanceModelPull(pull, { status: 'success', model: 'text:1b' });
  assert.equal(pull.percent, 50, 'one model done is not the whole download');
  pull = advanceModelPull(pull, { status: 'success', model: 'vision:2b' });
  assert.equal(pull.percent, 100);
});

test('a model the screen did not expect widens the total instead of overshooting', () => {
  // The runtime pulls the whole required set; a tag the screen never listed must
  // widen the denominator rather than push the bar past 100%.
  let pull = startModelPull(['text:1b']);
  pull = advanceModelPull(pull, { status: 'downloading', model: 'text:1b', percent: 50 });
  assert.equal(pull.percent, 50);
  pull = advanceModelPull(pull, { status: 'downloading', model: 'surprise:4b', percent: 50 });
  assert.equal(pull.percent, 75, 'one model done plus half of two is three quarters');
  assert.match(pull.text, /2 of 2/, 'the widened total is what the user is told');
  pull = advanceModelPull(pull, { status: 'success', model: 'surprise:4b' });
  assert.equal(pull.percent, 100);
});

test('progress with no model name still advances a single-model download', () => {
  // `pullModel` names every line today, but the field is optional in the
  // contract and an unnamed line must not be treated as a new model.
  let pull = startModelPull(['solo:8b']);
  pull = advanceModelPull(pull, { status: 'downloading', percent: 40 });
  assert.equal(pull.percent, 40);
  pull = advanceModelPull(pull, { status: 'success' });
  assert.equal(pull.percent, 100);
});

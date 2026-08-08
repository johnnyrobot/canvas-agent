import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeHealth } from '../../contracts/index.js';
import { downloadModelAffordance, missingRequiredModels, missingModelsText } from './model-health.js';

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

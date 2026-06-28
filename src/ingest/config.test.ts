import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIngestConfig, parseExportFormats } from './config.js';

test('defaults match PRD Appendix H', () => {
  const c = loadIngestConfig({});
  assert.equal(c.baseUrl, 'http://localhost:5001');
  assert.deepEqual(c.exportFormats, ['html', 'json']);
  assert.equal(c.ocrEnabled, true);
  assert.equal(c.manageProcess, true);
  assert.equal(c.ocrEngine, undefined); // omitted unless set
  // Classic pipeline stays the default workhorse; the Granite-Docling VLM is
  // one env var away (deep-research 2026-06-27: VLM does NOT replace classic).
  assert.equal(c.pipeline, 'standard');
  assert.equal(c.vlmPreset, 'granite_docling');
});

test('INGEST_PIPELINE selects the VLM pipeline', () => {
  assert.equal(loadIngestConfig({ INGEST_PIPELINE: 'vlm' }).pipeline, 'vlm');
  assert.equal(loadIngestConfig({ INGEST_PIPELINE: 'standard' }).pipeline, 'standard');
});

test('INGEST_PIPELINE rejects an unknown pipeline', () => {
  assert.throws(() => loadIngestConfig({ INGEST_PIPELINE: 'legacy' }), /Unknown INGEST_PIPELINE: legacy/);
});

test('INGEST_VLM_PRESET overrides the VLM preset (e.g. speed tier)', () => {
  assert.equal(loadIngestConfig({ INGEST_VLM_PRESET: 'smoldocling' }).vlmPreset, 'smoldocling');
});

test('trailing slash is stripped from the base URL', () => {
  assert.equal(loadIngestConfig({ DOCLING_SERVE_URL: 'http://localhost:5001/' }).baseUrl, 'http://localhost:5001');
});

test('DOCLING_OCR_ENGINE is threaded when set', () => {
  assert.equal(loadIngestConfig({ DOCLING_OCR_ENGINE: 'ocrmac' }).ocrEngine, 'ocrmac');
});

test('parseExportFormats validates and falls back', () => {
  assert.deepEqual(parseExportFormats('md, doctags'), ['md', 'doctags']);
  assert.deepEqual(parseExportFormats(''), ['html', 'json']);
  assert.throws(() => parseExportFormats('md,pdf'), /Unknown DOCLING_EXPORT format: pdf/);
});

test('DOCLING_OCR_ENABLED=false is respected', () => {
  assert.equal(loadIngestConfig({ DOCLING_OCR_ENABLED: 'false' }).ocrEnabled, false);
});

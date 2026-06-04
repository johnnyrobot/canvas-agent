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

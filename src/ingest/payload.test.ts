import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadIngestConfig } from './config.js';
import { buildConvertOptions, buildFileRequest, buildUrlRequest, normalizeResponse } from './payload.js';

const config = loadIngestConfig({ DOCLING_OCR_ENGINE: 'ocrmac' });

test('buildConvertOptions maps config + overrides to docling fields', () => {
  const opts = buildConvertOptions({ toFormats: ['md'], forceOcr: true }, config);
  assert.deepEqual(opts.to_formats, ['md']);
  assert.equal(opts.do_ocr, true); // from config default
  assert.equal(opts.force_ocr, true); // override
  assert.equal(opts.ocr_engine, 'ocrmac');
});

test('buildFileRequest uses file_sources with base64 + filename', () => {
  const req = buildFileRequest({ base64: 'QUJD', filename: 'syllabus.docx' }, {}, config);
  assert.deepEqual(req.file_sources, [{ base64_string: 'QUJD', filename: 'syllabus.docx' }]);
  assert.equal(req.http_sources, undefined);
  assert.deepEqual(req.options.to_formats, ['html', 'json']);
});

test('buildUrlRequest uses http_sources', () => {
  const req = buildUrlRequest('https://x/y.pdf', {}, config);
  assert.deepEqual(req.http_sources, [{ url: 'https://x/y.pdf' }]);
  assert.equal(req.file_sources, undefined);
});

test('normalizeResponse extracts requested format contents', () => {
  const doc = normalizeResponse({
    document: { md_content: '# Title', json_content: { a: 1 }, html_content: '<h1>Title</h1>' },
    status: 'success',
    processing_time: 1.5,
  });
  assert.equal(doc.status, 'success');
  assert.equal(doc.processingTimeMs, 1500);
  assert.equal(doc.markdown, '# Title');
  assert.equal(doc.html, '<h1>Title</h1>');
  assert.deepEqual(doc.json, { a: 1 });
  assert.equal(doc.text, undefined); // not requested/returned
});

test('normalizeResponse is defensive about missing fields', () => {
  const doc = normalizeResponse({});
  assert.equal(doc.status, 'failure');
  assert.equal(doc.processingTimeMs, 0);
  assert.equal(doc.markdown, undefined);
});

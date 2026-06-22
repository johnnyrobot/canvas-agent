import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  RuntimeHealth,
  ScreenshotAttachment,
  ScreenshotSource,
  TurnRequest,
  UploadedDocument,
} from './index.js';

test('TurnRequest accepts local screenshot attachments', () => {
  const attachment: ScreenshotAttachment = {
    id: 'shot-1',
    kind: 'screenshot',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,QUJD',
    label: 'Entire Screen',
    capturedAt: '2026-01-01T00:00:00.000Z',
  };
  const req: TurnRequest = { user: 'What is this Canvas screen?', attachments: [attachment] };
  assert.equal(req.attachments?.[0]?.kind, 'screenshot');
  assert.match(req.attachments?.[0]?.dataUrl ?? '', /^data:image\/png;base64,/);
});

test('screenshot source and model health are serializable contract shapes', () => {
  const source: ScreenshotSource = {
    id: 'window:1:0',
    kind: 'window',
    label: 'Canvas - Course Settings',
    thumbnailDataUrl: 'data:image/png;base64,',
  };
  const health: RuntimeHealth = {
    llm: true,
    ingest: true,
    model: { tag: 'gemma4:31b', available: false, installCommand: 'ollama pull gemma4:31b' },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(source)), source);
  assert.equal(health.model?.installCommand, 'ollama pull gemma4:31b');
});

test('uploaded document conversion shape is serializable', () => {
  const doc: UploadedDocument = {
    filename: 'syllabus.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    sizeBytes: 12,
    dataUrl: 'data:application/octet-stream;base64,QUJD',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

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
    model: { tag: 'granite4.1:8b', status: 'missing' as const, recovery: 'ollama pull granite4.1:8b' },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(source)), source);
  assert.equal(health.model?.recovery, 'ollama pull granite4.1:8b');
});

test('RuntimeHealth carries the two required models as siblings, each its own tag (ADR-0009)', () => {
  // `visionModel` is a sibling optional field, not an element of a list — the
  // required set is fixed at two, so a list would only be indexed by role.
  const recovery = 'ollama pull granite4.1:8b && ollama pull a-vision-model:4b';
  const health: RuntimeHealth = {
    llm: true,
    ingest: true,
    model: { tag: 'granite4.1:8b', status: 'missing' as const, recovery: recovery },
    visionModel: { tag: 'a-vision-model:4b', status: 'missing' as const, recovery: recovery },
    ingestModel: { available: true },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(health)), health, 'the whole payload survives IPC');
  assert.notEqual(health.model?.tag, health.visionModel?.tag, 'each required model reports its own tag');
  // The recovery path is manual and taken after automation failed: it names both.
  assert.ok(health.visionModel?.recovery.includes('granite4.1:8b'));
  assert.ok(health.visionModel?.recovery.includes('a-vision-model:4b'));
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

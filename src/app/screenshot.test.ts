import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppApi, ScreenshotPermissionStatus } from '../contracts/index.js';
import { createUnavailableApi } from './unavailable-api.js';
import { withScreenshotCapture } from './screenshot.js';

function api(status: ScreenshotPermissionStatus = 'granted'): AppApi {
  return withScreenshotCapture(createUnavailableApi('unused'), {
    permissionStatus: () => status,
    getSources: async () => [
      {
        id: 'screen:1:0',
        name: 'Entire Screen',
        thumbnail: { toDataURL: () => 'data:image/png;base64,SCREEN' },
      },
      {
        id: 'window:2:0',
        name: 'Canvas - Settings',
        thumbnail: { toDataURL: () => 'data:image/png;base64,WINDOW', isEmpty: () => false },
      },
    ],
    now: () => '2026-01-01T00:00:00.000Z',
    randomId: () => 'shot-1',
  });
}

test('listScreenshotSources returns screen/window metadata with thumbnails', async () => {
  const sources = await api().listScreenshotSources();
  assert.deepEqual(sources, [
    {
      id: 'screen:1:0',
      kind: 'screen',
      label: 'Entire Screen',
      thumbnailDataUrl: 'data:image/png;base64,SCREEN',
    },
    {
      id: 'window:2:0',
      kind: 'window',
      label: 'Canvas - Settings',
      thumbnailDataUrl: 'data:image/png;base64,WINDOW',
    },
  ]);
});

test('captureScreenshot returns a transient PNG screenshot attachment', async () => {
  const shot = await api().captureScreenshot('window:2:0');
  assert.deepEqual(shot, {
    id: 'shot-1',
    kind: 'screenshot',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,WINDOW',
    label: 'Canvas - Settings',
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
});

test('screenshot capture refuses denied or restricted screen permissions', async () => {
  await assert.rejects(() => api('denied').listScreenshotSources(), /Screen recording permission/);
  await assert.rejects(() => api('restricted').captureScreenshot('screen:1:0'), /Screen recording permission/);
});

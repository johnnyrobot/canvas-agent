import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  CHUNK,
  RUN_TURN,
  SAVE_CANVAS_AUTH,
  IMPORT_CANVAS,
  HEALTH,
  PULL_MODEL,
  PULL_INGEST_MODEL,
  INGEST_PULL_PROGRESS,
  CREATE_SESSION,
  LIST_SESSIONS,
  LOAD_SESSION,
  DELETE_SESSION,
  RESOLVE_BRAND_THEME,
  LIST_BRAND_KITS,
  SAVE_BRAND_KIT,
  DELETE_BRAND_KIT,
  FETCH_CANVAS_PAGE,
  LIST_CANVAS_PAGES,
  CONVERT_DOCUMENT,
  SCREENSHOT_PERMISSION_STATUS,
  LIST_SCREENSHOT_SOURCES,
  CAPTURE_SCREENSHOT,
} from './channels.js';

test('exposes the original three IPC channel names', () => {
  assert.equal(RUN_TURN, 'canvasAgent:runTurn');
  assert.equal(IMPORT_CANVAS, 'canvasAgent:importCanvas');
  assert.equal(HEALTH, 'canvasAgent:health');
});

test('CHANNELS bundles every request/response channel, keyed by AppApi method', () => {
  assert.deepEqual(CHANNELS, {
    runTurn: RUN_TURN,
    saveCanvasAuth: SAVE_CANVAS_AUTH,
    importCanvas: IMPORT_CANVAS,
    health: HEALTH,
    pullModel: PULL_MODEL,
    pullIngestModel: PULL_INGEST_MODEL,
    createSession: CREATE_SESSION,
    listSessions: LIST_SESSIONS,
    loadSession: LOAD_SESSION,
    deleteSession: DELETE_SESSION,
    resolveBrandTheme: RESOLVE_BRAND_THEME,
    listBrandKits: LIST_BRAND_KITS,
    saveBrandKit: SAVE_BRAND_KIT,
    deleteBrandKit: DELETE_BRAND_KIT,
    fetchCanvasPage: FETCH_CANVAS_PAGE,
    listCanvasPages: LIST_CANVAS_PAGES,
    convertDocument: CONVERT_DOCUMENT,
    screenshotPermissionStatus: SCREENSHOT_PERMISSION_STATUS,
    listScreenshotSources: LIST_SCREENSHOT_SOURCES,
    captureScreenshot: CAPTURE_SCREENSHOT,
  });
});

test('channel names are all distinct', () => {
  const values = Object.values(CHANNELS);
  assert.equal(new Set(values).size, values.length, 'channel names must be unique');
});

test('every channel name (incl. the CHUNK event) is namespaced under "canvasAgent:"', () => {
  for (const name of [...Object.values(CHANNELS), CHUNK]) {
    assert.match(name, /^canvasAgent:/);
  }
});

test('CHUNK is a separate one-way event channel, NOT part of CHANNELS', () => {
  assert.equal(CHUNK, 'canvasAgent:chunk');
  assert.ok(
    !Object.values(CHANNELS).includes(CHUNK as (typeof CHANNELS)[keyof typeof CHANNELS]),
    'CHUNK must not be a request/response handler channel',
  );
});

test('INGEST_PULL_PROGRESS is a separate one-way event channel, NOT part of CHANNELS', () => {
  assert.equal(INGEST_PULL_PROGRESS, 'canvasAgent:ingestPullProgress');
  assert.ok(
    !Object.values(CHANNELS).includes(INGEST_PULL_PROGRESS as (typeof CHANNELS)[keyof typeof CHANNELS]),
    'INGEST_PULL_PROGRESS must not be a request/response handler channel',
  );
});

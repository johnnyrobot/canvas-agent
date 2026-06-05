import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  CHUNK,
  RUN_TURN,
  IMPORT_CANVAS,
  HEALTH,
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
} from './channels.js';

test('exposes the original three IPC channel names', () => {
  assert.equal(RUN_TURN, 'canvasAgent:runTurn');
  assert.equal(IMPORT_CANVAS, 'canvasAgent:importCanvas');
  assert.equal(HEALTH, 'canvasAgent:health');
});

test('CHANNELS bundles every request/response channel, keyed by AppApi method', () => {
  assert.deepEqual(CHANNELS, {
    runTurn: RUN_TURN,
    importCanvas: IMPORT_CANVAS,
    health: HEALTH,
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

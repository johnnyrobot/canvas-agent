import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSidecarCommand, resolveIngestModelEnv } from './bundled-resources.js';

test('falls back to the bare command name in dev (no process.resourcesPath)', () => {
  const cmd = resolveSidecarCommand('ollama', 'ollama', undefined, () => true);
  assert.equal(cmd, 'ollama');
});

test('resolves the bundled abs path when staged under <resources>/sidecars/<name>/<name>', () => {
  const seen: string[] = [];
  const exists = (p: string) => {
    seen.push(p);
    return true;
  };
  const cmd = resolveSidecarCommand('ollama', 'ollama', '/Apps/Canvas Agent.app/Contents/Resources', exists);
  assert.equal(cmd, path.join('/Apps/Canvas Agent.app/Contents/Resources', 'sidecars', 'ollama', 'ollama'));
  assert.deepEqual(seen, ['/Apps/Canvas Agent.app/Contents/Resources/sidecars/ollama/ollama']);
});

test('falls back to PATH when resourcesPath is set but the binary is not staged', () => {
  const cmd = resolveSidecarCommand('docling-serve', 'docling-serve', '/Resources', () => false);
  assert.equal(cmd, 'docling-serve');
});

test('uses the docling-serve naming convention (sidecars/<name>/<name>)', () => {
  const cmd = resolveSidecarCommand('docling-serve', 'docling-serve', '/R', () => true);
  assert.equal(cmd, path.join('/R', 'sidecars', 'docling-serve', 'docling-serve'));
});

test('defaults the fallback to the command name', () => {
  // No resourcesPath → returns fallback; fallback defaults to `name`.
  assert.equal(resolveSidecarCommand('ollama', undefined, undefined, () => true), 'ollama');
});

test('a custom fallback is honored when nothing is staged', () => {
  assert.equal(resolveSidecarCommand('ollama', '/opt/homebrew/bin/ollama', undefined, () => true), '/opt/homebrew/bin/ollama');
});

// --- resolveIngestModelEnv: which model store this build serves from ---------
//
// The bug these guard (ADR-0008): with the models bundled, the app used to point
// DOCLING_MODELS_DIR at the EMPTY per-user store, so `modelsPresent()` reported
// false and the UI offered a download that was not needed. Conversion worked the
// whole time — the app was simply wrong about itself.

const RES = '/Apps/Canvas Agent.app/Contents/Resources';
const BUNDLE = path.join(RES, 'sidecars', 'docling-serve', 'models');

test('bundled build: points at the bundled models and marks the build bundled', () => {
  const env = resolveIngestModelEnv({
    packaged: true,
    userModelsDir: '/Users/me/Library/Application Support/canvas-agent/models',
    env: {},
    resourcesPath: RES,
    isNonEmptyDir: (p) => p === BUNDLE,
  });
  assert.equal(env.DOCLING_MODELS_DIR, BUNDLE, 'serves from the bundle, not the per-user store');
  assert.equal(env.DOCLING_MODELS_BUNDLED, '1', 'the build knows the models are bundled');
});

test('dev build: no overrides at all, even when a bundle happens to be staged', () => {
  const env = resolveIngestModelEnv({
    packaged: false,
    userModelsDir: '/Users/me/store',
    env: {},
    resourcesPath: RES,
    isNonEmptyDir: () => true,
  });
  assert.deepEqual(env, {}, 'dev behaviour must be byte-for-byte unchanged');
});

test('an explicit DOCLING_MODELS_DIR wins over the bundle (operator override)', () => {
  const env = resolveIngestModelEnv({
    packaged: true,
    userModelsDir: '/Users/me/store',
    env: { DOCLING_MODELS_DIR: '/opt/my-own-models' },
    resourcesPath: RES,
    isNonEmptyDir: () => true,
  });
  assert.deepEqual(env, {}, 'never override an explicitly configured store');
});

test('packaged with no bundled models: falls back to the per-user store', () => {
  const env = resolveIngestModelEnv({
    packaged: true,
    userModelsDir: '/Users/me/store',
    env: {},
    resourcesPath: RES,
    isNonEmptyDir: () => false,
  });
  assert.equal(env.DOCLING_MODELS_DIR, '/Users/me/store', 'first-run pull into the per-user store');
  assert.equal(env.DOCLING_MODELS_BUNDLED, undefined, 'not a bundled build');
});

test('a staged-but-EMPTY models dir is not a bundled build', () => {
  // The half-staged payload: the dir exists, so a presence check would pass it.
  const env = resolveIngestModelEnv({
    packaged: true,
    userModelsDir: '/Users/me/store',
    env: {},
    resourcesPath: RES,
    isNonEmptyDir: (p) => p !== BUNDLE,
  });
  assert.equal(env.DOCLING_MODELS_DIR, '/Users/me/store');
  assert.equal(env.DOCLING_MODELS_BUNDLED, undefined);
});

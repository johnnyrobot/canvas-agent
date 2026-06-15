import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveSidecarCommand } from './bundled-resources.js';

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

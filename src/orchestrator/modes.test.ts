import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PROMPT_BY_MODE,
  TOOLS_BY_MODE,
  KB_PACKS_BY_MODE,
  systemPromptForMode,
  toolsForMode,
  packsForMode,
} from './modes.js';
import { createCanonicalTools } from './tools.js';
import type { ProductMode } from '../contracts/index.js';

const MODES: ProductMode[] = ['guidance', 'build', 'remediate'];

/** The eight canonical tool names (PRD §15.3). */
const CANONICAL = [
  'audit_html',
  'validate_allowlist',
  'check_contrast',
  'resolve_theme',
  'render_template',
  'ingest_document',
  'describe_image',
  'retrieve_kb',
];

test('every mode has a prompt that keeps the hard rules and specializes', () => {
  for (const mode of MODES) {
    const prompt = systemPromptForMode(mode);
    assert.equal(prompt, SYSTEM_PROMPT_BY_MODE[mode]);
    // Hard rules preserved.
    assert.match(prompt, /Canvas-allowlist-safe HTML/);
    assert.match(prompt, /WCAG 2\.2 AA/);
    assert.match(prompt, /never claim something "passes" yourself/);
    assert.match(prompt, /Never fetch remote resources/);
    assert.match(prompt, /cite/i);
    // Mode-specific specialization present.
    assert.match(prompt, new RegExp(`Mode: ${mode.toUpperCase()}`));
  }
});

test('tool name sets match the brief, and every name is canonical', () => {
  assert.deepEqual(TOOLS_BY_MODE.guidance, ['retrieve_kb', 'check_contrast', 'audit_html', 'describe_image']);
  assert.deepEqual(TOOLS_BY_MODE.build, [
    'audit_html',
    'validate_allowlist',
    'check_contrast',
    'resolve_theme',
    'render_template',
    'ingest_document',
    'describe_image',
    'retrieve_kb',
  ]);
  assert.deepEqual(TOOLS_BY_MODE.remediate, [
    'audit_html',
    'validate_allowlist',
    'check_contrast',
    'resolve_theme',
    'retrieve_kb',
    'describe_image',
  ]);
  for (const mode of MODES) {
    for (const name of TOOLS_BY_MODE[mode]) assert.ok(CANONICAL.includes(name), `${name} is canonical`);
  }
  // build sees all eight canonical tools.
  assert.equal(new Set(TOOLS_BY_MODE.build).size, CANONICAL.length);
});

test('KB packs match the brief', () => {
  assert.deepEqual(KB_PACKS_BY_MODE.guidance, ['wcag-basics', 'rubric-criteria']);
  assert.deepEqual(KB_PACKS_BY_MODE.build, ['canvas-templates', 'wcag-basics']);
  assert.deepEqual(KB_PACKS_BY_MODE.remediate, ['wcag-basics']);
});

test('toolsForMode filters real canonical definitions by name', () => {
  // Build the real 8 definitions (deps irrelevant — we only read names here).
  const all = createCanonicalTools({}).map((t) => t.definition);
  assert.equal(all.length, 8);

  for (const mode of MODES) {
    const filtered = toolsForMode(mode, all);
    const names = filtered.map((t) => t.name);
    assert.deepEqual(new Set(names), new Set(TOOLS_BY_MODE[mode]));
    // Filtering only ever removes — never invents — definitions.
    for (const t of filtered) assert.ok(all.includes(t));
  }

  // Guidance is a strict subset (it omits validate_allowlist, resolve_theme, etc.).
  assert.equal(toolsForMode('guidance', all).length, 4);
  assert.equal(toolsForMode('build', all).length, 8);
  assert.equal(toolsForMode('remediate', all).length, 6);
});

test('toolsForMode ignores names not present in the supplied set', () => {
  const partial = createCanonicalTools({})
    .map((t) => t.definition)
    .filter((d) => d.name === 'audit_html');
  assert.deepEqual(toolsForMode('build', partial).map((t) => t.name), ['audit_html']);
});

test('packsForMode returns a fresh mutable copy', () => {
  const a = packsForMode('guidance');
  a.push('mutated');
  assert.deepEqual(packsForMode('guidance'), ['wcag-basics', 'rubric-criteria']);
});

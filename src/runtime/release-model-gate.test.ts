import test from 'node:test';
import assert from 'node:assert/strict';

import { checkShippedModelTags, type ShippedTagProbe } from './release-model-gate.js';
import { RUNTIME_DEFAULT_MODEL, RUNTIME_DEFAULT_VISION_MODEL } from './deps.js';

/** A probe that answers every tag the same way, recording what it was asked. */
function probeAll(
  answer: { resolves: boolean; capabilities: readonly string[] },
  asked: string[] = [],
): ShippedTagProbe {
  return async (tag) => {
    asked.push(tag);
    return answer;
  };
}

test('the shipped defaults pass when every tag resolves and reports its role capabilities', async () => {
  const asked: string[] = [];
  const checks = await checkShippedModelTags(
    probeAll({ resolves: true, capabilities: ['completion', 'tools', 'vision'] }, asked),
  );

  // One check per required ROLE, in role order — and the tags probed are the
  // ones the app actually ships, so swapping a default re-points the gate
  // rather than leaving it asserting a stale string.
  assert.deepEqual(
    checks.map((c) => c.role),
    ['text', 'vision'],
  );
  assert.deepEqual(asked, [RUNTIME_DEFAULT_MODEL, RUNTIME_DEFAULT_VISION_MODEL]);
  assert.deepEqual(
    checks.map((c) => c.tag),
    [RUNTIME_DEFAULT_MODEL, RUNTIME_DEFAULT_VISION_MODEL],
  );
  assert.ok(
    checks.every((c) => c.ok),
    `the shipped defaults must pass: ${checks.map((c) => c.detail).join(' | ')}`,
  );
});

test('a tag that does not resolve on the registry fails', async () => {
  const checks = await checkShippedModelTags(async (tag) => ({
    resolves: tag !== RUNTIME_DEFAULT_VISION_MODEL,
    capabilities: ['completion', 'tools', 'vision'],
  }));

  const text = checks.find((c) => c.role === 'text')!;
  const vision = checks.find((c) => c.role === 'vision')!;
  assert.equal(text.ok, true, 'a resolvable tag is unaffected');
  assert.equal(vision.ok, false);
  // The recovery the app prints to a stranded user is `ollama pull <tag>`, so
  // the failure has to name that, not merely say "unresolvable".
  assert.match(vision.detail, /ollama pull/);
  assert.match(vision.detail, new RegExp(RUNTIME_DEFAULT_VISION_MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a tag that resolves but cannot do its role fails, naming the capability and the env var', async () => {
  const checks = await checkShippedModelTags(async (tag) => ({
    resolves: true,
    // The exact shape of the break that shipped once: a tag that pulls fine and
    // cannot see.
    capabilities: tag === RUNTIME_DEFAULT_VISION_MODEL ? ['completion', 'tools'] : ['completion', 'tools'],
  }));

  const vision = checks.find((c) => c.role === 'vision')!;
  assert.equal(vision.ok, false);
  assert.match(vision.detail, /vision/);
  assert.match(vision.detail, /MODEL_VISION/);
  // A pull cannot fix an incapable tag, so the gate must not suggest one.
  assert.doesNotMatch(vision.detail, /ollama pull/);
});

test('a text tag that cannot call tools fails too — capability is per role', async () => {
  const checks = await checkShippedModelTags(async () => ({
    resolves: true,
    capabilities: ['completion', 'vision'],
  }));

  const text = checks.find((c) => c.role === 'text')!;
  assert.equal(text.ok, false);
  assert.match(text.detail, /tools/);
  assert.match(text.detail, /MODEL_TEXT/);
});

test('a probe that cannot answer fails closed — being offline never passes', async () => {
  const checks = await checkShippedModelTags(async () => {
    throw new Error('getaddrinfo ENOTFOUND registry.ollama.ai');
  });

  assert.ok(checks.length > 0, 'a probe failure must still produce checks to fail');
  assert.ok(
    checks.every((c) => !c.ok),
    'an unanswerable probe must not be read as a pass',
  );
  assert.match(checks[0]!.detail, /ENOTFOUND/);
});

test('the packaging machine’s own env cannot narrow or re-point what is checked', async () => {
  // Both of these are legitimate on a DEV machine and neither describes the DMG.
  // `LLM_VISION_ENABLED=false` removes the vision role from the RUNTIME's
  // required set (ADR-0010); `MODEL_VISION` re-points the role for that machine
  // only. The release still ships both defaults to every user, so the gate reads
  // the shipped defaults and nothing else — an exported override that quietly
  // moved the gate onto a tag we are not shipping would be worse than no gate.
  const saved = { vision: process.env.MODEL_VISION, enabled: process.env.LLM_VISION_ENABLED };
  process.env.LLM_VISION_ENABLED = 'false';
  process.env.MODEL_VISION = 'an-operators-own-vision:tag';
  try {
    const asked: string[] = [];
    const checks = await checkShippedModelTags(
      probeAll({ resolves: true, capabilities: ['completion', 'tools', 'vision'] }, asked),
    );
    assert.deepEqual(asked, [RUNTIME_DEFAULT_MODEL, RUNTIME_DEFAULT_VISION_MODEL]);
    assert.deepEqual(
      checks.map((c) => c.tag),
      [RUNTIME_DEFAULT_MODEL, RUNTIME_DEFAULT_VISION_MODEL],
    );
  } finally {
    for (const [key, value] of [
      ['MODEL_VISION', saved.vision],
      ['LLM_VISION_ENABLED', saved.enabled],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

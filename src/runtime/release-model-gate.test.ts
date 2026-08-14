import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkShippedModelTags,
  manifestUrl,
  type ShippedTagProbe,
  type ShippedTagProbeResult,
} from './release-model-gate.js';
import { RUNTIME_DEFAULT_MODEL, RUNTIME_DEFAULT_VISION_MODEL } from './deps.js';

const DIGEST = 'a'.repeat(64);

/** A tag in perfect health: resolves, local copy is current, does everything. */
const HEALTHY: ShippedTagProbeResult = {
  resolves: true,
  capabilities: ['completion', 'tools', 'vision'],
  registryDigest: DIGEST,
  localDigest: DIGEST,
};

/** A probe that answers every tag alike, recording which tags it was asked about. */
function probeAll(answer: Partial<ShippedTagProbeResult> = {}, asked: string[] = []): ShippedTagProbe {
  return async (tag) => {
    asked.push(tag);
    return { ...HEALTHY, ...answer };
  };
}

/** Escape a model tag for use inside a RegExp (tags carry `.` and `:`). */
const literal = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

test('the shipped defaults pass when every tag resolves and reports its role capabilities', async () => {
  const asked: string[] = [];
  const checks = await checkShippedModelTags(probeAll({}, asked));

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
  const checks = await checkShippedModelTags(async (tag) =>
    tag === RUNTIME_DEFAULT_VISION_MODEL
      ? { ...HEALTHY, resolves: false, registryDigest: '' }
      : HEALTHY,
  );

  const text = checks.find((c) => c.role === 'text')!;
  const vision = checks.find((c) => c.role === 'vision')!;
  assert.equal(text.ok, true, 'a resolvable tag is unaffected');
  assert.equal(vision.ok, false);
  // The recovery the app prints to a stranded user is `ollama pull <tag>`, so
  // the failure has to name that, not merely say "unresolvable".
  assert.match(vision.detail, /ollama pull/);
  assert.match(vision.detail, literal(RUNTIME_DEFAULT_VISION_MODEL));
});

test('a tag that resolves but cannot do its role fails, naming the capability and the env var', async () => {
  // The exact shape of the break that shipped once: a tag that pulls fine and
  // cannot see. Both roles get the same answer, so the text role passes on the
  // same input the vision role fails on — capability is per role, not per tag.
  const checks = await checkShippedModelTags(probeAll({ capabilities: ['completion', 'tools'] }));

  assert.equal(checks.find((c) => c.role === 'text')!.ok, true);
  const vision = checks.find((c) => c.role === 'vision')!;
  assert.equal(vision.ok, false);
  assert.match(vision.detail, /vision/);
  assert.match(vision.detail, /MODEL_VISION/);
  // A pull cannot fix an incapable tag, so the gate must not suggest one.
  assert.doesNotMatch(vision.detail, /ollama pull/);
});

test('a text tag that cannot call tools fails too — capability is per role', async () => {
  const checks = await checkShippedModelTags(probeAll({ capabilities: ['completion', 'vision'] }));

  const text = checks.find((c) => c.role === 'text')!;
  assert.equal(text.ok, false);
  assert.match(text.detail, /tools/);
  assert.match(text.detail, /MODEL_TEXT/);
});

test('capabilities read from a copy the registry no longer serves fail, and a pull is the fix', async () => {
  // Capabilities can only be read from a local copy — no registry publishes
  // them. That makes the reading only as good as the copy: a tag is a mutable
  // pointer, so the box may hold something the tag stopped meaning months ago,
  // and "it reports vision here" would say nothing about what a user pulls.
  // Comparing manifest digests is what turns the local reading into evidence
  // about the shipped tag.
  const checks = await checkShippedModelTags(probeAll({ localDigest: 'b'.repeat(64) }));

  assert.ok(
    checks.every((c) => !c.ok),
    'a stale local copy proves nothing about either role',
  );
  assert.match(checks[0]!.detail, /STALE/);
  // Unlike the incapable case, a pull is exactly what fixes this.
  assert.match(checks[0]!.detail, /ollama pull/);
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
    const checks = await checkShippedModelTags(probeAll({}, asked));
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

// --- where a tag's manifest lives -------------------------------------------
// Pure, and therefore HERE rather than beside the fetch that uses it: this is
// the single point at which the whole gate could probe the wrong URL, get a
// confident 200 from something that is not the shipped model, and pass.

test('a bare library tag resolves against registry.ollama.ai/library, defaulting to :latest', () => {
  assert.equal(manifestUrl('qwen3-vl:4b'), 'https://registry.ollama.ai/v2/library/qwen3-vl/manifests/4b');
  assert.equal(
    manifestUrl('granite4.1'),
    'https://registry.ollama.ai/v2/library/granite4.1/manifests/latest',
  );
});

test('a namespaced tag keeps its namespace instead of being read as a library model', () => {
  assert.equal(manifestUrl('someone/model:tag'), 'https://registry.ollama.ai/v2/someone/model/manifests/tag');
});

test('an hf.co tag resolves to the QUANT, not merely the repo', () => {
  // The exposure that put this gate in the release path: an `hf.co/...` default
  // is one owner's repo, renameable and withdrawable. Checking the repo alone
  // would wave through a withdrawn quant inside a live repo — and the quant is
  // the thing `ollama pull` actually fetches.
  assert.equal(
    manifestUrl('hf.co/ibm-granite/granite-vision-4.1-4b-GGUF:Q4_K_M'),
    'https://huggingface.co/v2/ibm-granite/granite-vision-4.1-4b-GGUF/manifests/Q4_K_M',
  );
});

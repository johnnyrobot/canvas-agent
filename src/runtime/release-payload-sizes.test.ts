import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  EXPECTED_PAYLOADS,
  PAYLOAD_IDS,
  checkPayloadSize,
  formatPayloadSize,
  type PayloadId,
} from './release-payload-sizes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('payload size bands (#48)', () => {
  test('a payload at its expected size passes', () => {
    for (const id of PAYLOAD_IDS) {
      const { expectedMb } = EXPECTED_PAYLOADS[id];
      assert.ok(checkPayloadSize(id, expectedMb).ok, `${id} should pass at exactly its expected size`);
    }
  });

  test('a partial payload still fails, as the floor already did', () => {
    for (const id of PAYLOAD_IDS) {
      const { expectedMb } = EXPECTED_PAYLOADS[id];
      assert.ok(!checkPayloadSize(id, 0).ok, `${id} must fail when absent`);
      assert.ok(!checkPayloadSize(id, expectedMb / 2).ok, `${id} must fail at half its expected size`);
    }
  });

  test('a payload that GROWS beyond its band fails', () => {
    // The whole point of the ticket. Under the old floor every one of these
    // passed silently — which is how the DMG went 966 MB → 2.86 GB with every
    // gate green.
    for (const id of PAYLOAD_IDS) {
      const { expectedMb } = EXPECTED_PAYLOADS[id];
      assert.ok(!checkPayloadSize(id, expectedMb * 2).ok, `${id} must fail at double its expected size`);
    }
  });

  test('the failure names the expected band, not just the measurement', () => {
    // A gate that says only "1852 MB" leaves the operator to guess whether that
    // is bad, and by how much. It has to state what it wanted.
    const { detail } = checkPayloadSize('doclingModels', 4000);
    assert.match(detail, /4000 MB/, 'must report what it measured');
    assert.match(detail, /expected/i, 'must state that there was an expectation');
    const { expectedMb, tolerance } = EXPECTED_PAYLOADS.doclingModels;
    assert.ok(
      detail.includes(formatPayloadSize(Math.round(expectedMb * (1 + tolerance)))),
      `must name the upper bound of the band; got: ${detail}`,
    );
  });

  test('a passing check still reports the measurement', () => {
    const { ok, detail } = checkPayloadSize('doclingModels', EXPECTED_PAYLOADS.doclingModels.expectedMb);
    assert.ok(ok);
    assert.match(detail, /MB|GB/, 'a green row should still show the size it saw');
  });

  test('sizes render canonically, MB below a gigabyte and GB above', () => {
    assert.equal(formatPayloadSize(937), '937 MB');
    assert.equal(formatPayloadSize(1852), '1.8 GB');
    assert.equal(formatPayloadSize(2726), '2.7 GB');
  });

  test('every expected figure is a real measurement, not a placeholder', () => {
    // The figures this replaces were guesses that drifted 50% from reality and
    // nobody noticed. Each entry has to say where its number came from.
    for (const id of PAYLOAD_IDS) {
      const entry = EXPECTED_PAYLOADS[id];
      assert.ok(entry.expectedMb > 0, `${id} needs a real expected size`);
      assert.ok(entry.tolerance > 0 && entry.tolerance < 1, `${id} needs a sane tolerance fraction`);
      assert.ok(entry.measuredAt.length > 0, `${id} must record which build its figure came from`);
      assert.ok(entry.remedy.length > 0, `${id} must tell the operator what to do when it fails`);
    }
  });
});

describe('size figures restated in prose cannot drift (#48)', () => {
  // The expected sizes have ONE home, but prose still quotes them because an
  // operator reading RELEASING.md wants the number in front of them. Every such
  // quote carries a `payload:<id>` marker, and this test is what makes the
  // marker mean something: a figure that no longer matches the constant fails
  // here rather than sitting in the docs reading plausibly. That is not a
  // hypothetical — `~1.2 GB` appeared in four places while reality was 1.8 GB.
  const SOURCES = ['docs/RELEASING.md', 'scripts/build-docling-bundle.sh', 'scripts/pre-release.mjs'];

  test('every marked figure matches the constants module', () => {
    let markers = 0;
    for (const rel of SOURCES) {
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      // "~1.8 GB <!-- payload:doclingModels -->" / "(~1.8GB, slow)  # payload:doclingModels"
      const pattern = /([\d.]+)\s*(MB|GB)[^\n]*?payload:([A-Za-z]+)/g;
      for (const [, value, unit, id] of text.matchAll(pattern)) {
        assert.ok(value && unit && id, `malformed size marker in ${rel}`);
        markers += 1;
        assert.ok(
          (PAYLOAD_IDS as readonly string[]).includes(id),
          `${rel} references unknown payload id "${id}"`,
        );
        const expected = formatPayloadSize(EXPECTED_PAYLOADS[id as PayloadId].expectedMb);
        assert.equal(
          `${value} ${unit}`.replace(/\s+/g, ' '),
          expected,
          `${rel} quotes ${value} ${unit} for "${id}", but the constants module says ${expected}`,
        );
      }
    }
    assert.ok(markers >= 3, `expected the prose figures to be marked; found ${markers}`);
  });

  test('no unmarked size figure is left in the staging docs', () => {
    // An unmarked figure is one this test cannot police, which is exactly the
    // state that let four copies of "~1.2 GB" drift together. MB counts as much
    // as GB: the seed has been quoted as "~900 MB" and "898 MB" while measuring
    // 937 MB.
    const text = readFileSync(path.join(ROOT, 'docs/RELEASING.md'), 'utf8');
    const staging = text.slice(text.indexOf('## 3.'), text.indexOf('## 4.'));
    for (const line of staging.split('\n')) {
      if (!/[\d.]+\s*(MB|GB)/.test(line)) continue;
      assert.match(line, /payload:[A-Za-z]+/, `unmarked size figure in RELEASING.md §3: ${line.trim()}`);
    }
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoclingSidecar } from './sidecar.js';
import type { ConvertedDocument } from './types.js';

const ok: ConvertedDocument = { status: 'success', processingTimeMs: 0 };

function fakes() {
  const calls: string[] = [];
  let started = 0;
  const process = {
    ensureRunning: async () => {
      started++;
      calls.push('ensureRunning');
    },
    stop: async () => {},
    isHealthy: async () => true,
  };
  const client = {
    convertFile: async () => {
      calls.push('convertFile');
      return ok;
    },
    convertUrl: async () => {
      calls.push('convertUrl');
      return ok;
    },
  };
  return { calls, process, client, started: () => started };
}

test('convert ensures the docling-serve sidecar is running BEFORE converting (C4)', async () => {
  const f = fakes();
  const sidecar = createDoclingSidecar({ process: f.process, client: f.client });
  await sidecar.convert({ base64: 'QUJD', filename: 'syllabus.pdf' });
  assert.deepEqual(f.calls, ['ensureRunning', 'convertFile']);
});

test('the sidecar is started at most once across repeated conversions (C4)', async () => {
  const f = fakes();
  const sidecar = createDoclingSidecar({ process: f.process, client: f.client });
  await sidecar.convert({ base64: 'QUJD', filename: 'a.pdf' });
  await sidecar.convert({ base64: 'QUJD', filename: 'b.pdf' });
  assert.equal(f.started(), 1);
});

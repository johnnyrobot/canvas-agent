import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleBackground } from './sample.js';
import type { DecodedImage } from './png.js';

function img(pixels: number[][]): DecodedImage {
  const rgba = new Uint8Array(pixels.length * 4);
  pixels.forEach((p, i) => {
    rgba[i * 4] = p[0]!;
    rgba[i * 4 + 1] = p[1]!;
    rgba[i * 4 + 2] = p[2]!;
    rgba[i * 4 + 3] = p[3] ?? 255;
  });
  return { width: pixels.length, height: 1, rgba };
}

test('sampleBackground returns the lowest-contrast background pixel, ignoring text ink', () => {
  // black text pixel (dropped), white bg, mid-grey bg → worst case is the grey.
  const decoded = img([
    [0, 0, 0, 255],       // text ink (near fg) → ignored
    [255, 255, 255, 255], // white bg
    [119, 119, 119, 255], // grey bg (lower contrast vs black)
  ]);
  assert.deepEqual(sampleBackground(decoded, '#000000'), ['rgb(119, 119, 119)']);
});

test('sampleBackground returns [] when every pixel looks like the text color', () => {
  const decoded = img([[10, 10, 10, 255], [12, 12, 12, 255]]);
  assert.deepEqual(sampleBackground(decoded, '#000000'), []);
});

test('sampleBackground skips non-opaque pixels', () => {
  const decoded = img([[255, 255, 255, 0], [119, 119, 119, 255]]);
  assert.deepEqual(sampleBackground(decoded, '#000000'), ['rgb(119, 119, 119)']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePng } from './png.js';

/** Assemble a PNG chunk (CRC is zeroed; the decoder ignores CRC). */
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

/** Build an 8-bit RGBA (colorType 6) PNG from already-filtered scanlines. */
function makePng(width: number, height: number, filteredRows: Buffer[]): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(Buffer.concat(filteredRows));
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

test('decodePng round-trips a filter-0 (none) RGBA image', () => {
  // 2x1: red, then green.
  const row = Buffer.from([0, /*px0*/ 255, 0, 0, 255, /*px1*/ 0, 255, 0, 255]); // leading 0 = filter none
  const png = makePng(2, 1, [row]);
  const img = decodePng(png);
  assert.equal(img.width, 2);
  assert.equal(img.height, 1);
  assert.deepEqual([...img.rgba], [255, 0, 0, 255, 0, 255, 0, 255]);
});

test('decodePng applies the Up filter (type 2)', () => {
  // 1x2: row0 none = (10,20,30,255); row1 up adds row0 → stored deltas (5,5,5,0) → (15,25,35,255).
  const row0 = Buffer.from([0, 10, 20, 30, 255]);
  const row1 = Buffer.from([2, 5, 5, 5, 0]);
  const png = makePng(1, 2, [row0, row1]);
  const img = decodePng(png);
  assert.deepEqual([...img.rgba], [10, 20, 30, 255, 15, 25, 35, 255]);
});

test('decodePng throws on truncated scanline data instead of corrupting', () => {
  // IHDR says 2x2 RGBA (needs 2 rows of 1+8 bytes) but only one short row is provided.
  const png = makePng(2, 2, [Buffer.from([0, 1, 2, 3, 4])]);
  assert.throws(() => decodePng(png), /truncat/i);
});

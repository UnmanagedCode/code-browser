import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, jpegSize } from '../src/frame.js';
import { decodeFrame } from './helpers.mjs';
import { fakeJpeg } from './fakes/jpeg.mjs';

// Invariant: the wire frame is [u32 BE header length][header JSON][JPEG], round-tripping header and bytes exactly.
test('encodeFrame round-trips header and JPEG bytes', () => {
  const jpeg = fakeJpeg(40, 30, 7);
  const header = { seq: 3, tabId: 'T', width: 40, height: 30, meta: { deviceWidth: 1280 } };
  const buf = encodeFrame(header, jpeg);
  assert.equal(buf.readUInt32BE(0), Buffer.byteLength(JSON.stringify(header)));
  const out = decodeFrame(buf);
  assert.deepEqual(out.header, header);
  assert.ok(out.jpeg.equals(jpeg));
});

// Invariant: the header's pixel size comes from the JPEG's SOF marker; non-JPEG data yields null, not a crash.
test('jpegSize reads dimensions and rejects non-JPEG data', () => {
  assert.deepEqual(jpegSize(fakeJpeg(1280, 720)), { width: 1280, height: 720 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
  assert.equal(jpegSize(Buffer.alloc(0)), null);
  assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), null);
});

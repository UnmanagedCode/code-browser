import { describe, expect, it } from 'vitest';
import { decodeFrame } from './frame';

describe('decodeFrame', () => {
  // Invariant: the panel decodes the backend's wire format: [u32 BE header length][header JSON][JPEG bytes].
  it('splits header and jpeg bytes', () => {
    const header = { seq: 7, tabId: 'T1', width: 40, height: 30, meta: { deviceWidth: 1280, deviceHeight: 800, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 } };
    const head = new TextEncoder().encode(JSON.stringify(header));
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const buf = new Uint8Array(4 + head.length + jpeg.length);
    new DataView(buf.buffer).setUint32(0, head.length);
    buf.set(head, 4);
    buf.set(jpeg, 4 + head.length);
    const out = decodeFrame(buf.buffer);
    expect(out.header).toEqual(header);
    expect(Array.from(out.jpeg)).toEqual(Array.from(jpeg));
  });
});

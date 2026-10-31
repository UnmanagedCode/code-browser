// A buffer that is JPEG-shaped as far as the backend looks: SOI plus a baseline start-of-frame segment.
// Real decoding happens only in the real-Chromium E2E.
export function fakeJpeg(width, height, filler = 0) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9, filler])]);
}

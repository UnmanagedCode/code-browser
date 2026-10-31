// Binary screencast frame: [u32 BE headerLen][header JSON][JPEG bytes].
export function encodeFrame(header, jpeg) {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(4 + head.length + jpeg.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  jpeg.copy(out, 4 + head.length);
  return out;
}

// Pixel size from the JPEG's start-of-frame marker, or null for data that is not a JPEG.
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

import type { FrameHeader } from './protocol';

// Binary frame: [u32 BE headerLen][header JSON][JPEG bytes].
export function decodeFrame(buf: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } {
  const view = new DataView(buf);
  const headLen = view.getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLen))) as FrameHeader;
  return { header, jpeg: new Uint8Array(buf, 4 + headLen) };
}

import type { FrameMeta } from '../protocol';

export interface Rect { left: number; top: number; width: number; height: number }
export interface FrameGeometry { imageWidth: number; imageHeight: number; meta: FrameMeta }

// Client coordinates -> page CSS pixels, through the letterboxed image rect (`object-fit: contain`).
// Points outside the drawn image give null.
export function mapPoint(clientX: number, clientY: number, box: Rect, frame: FrameGeometry): { x: number; y: number } | null {
  const { imageWidth, imageHeight, meta } = frame;
  if (!imageWidth || !imageHeight || !box.width || !box.height) return null;
  const scale = Math.min(box.width / imageWidth, box.height / imageHeight);
  const offsetX = (box.width - imageWidth * scale) / 2;
  const offsetY = (box.height - imageHeight * scale) / 2;
  const ix = (clientX - box.left - offsetX) / scale;
  const iy = (clientY - box.top - offsetY) / scale;
  if (ix < 0 || iy < 0 || ix > imageWidth || iy > imageHeight) return null;
  return { x: ix * (meta.deviceWidth / imageWidth), y: iy * (meta.deviceHeight / imageHeight) };
}

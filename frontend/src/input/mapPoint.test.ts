import { describe, expect, it } from 'vitest';
import { mapPoint } from './mapPoint';

const meta = { deviceWidth: 1000, deviceHeight: 500, offsetTop: 0, pageScaleFactor: 1, scrollOffsetX: 0, scrollOffsetY: 0 };
const frame = { imageWidth: 500, imageHeight: 250, meta };

describe('mapPoint', () => {
  // Invariant: a point in the drawn image maps to page CSS pixels through the image-to-device scale.
  it('maps through scale when the canvas box has the image aspect', () => {
    expect(mapPoint(100, 50, { left: 0, top: 0, width: 1000, height: 500 }, frame)).toEqual({ x: 100, y: 50 });
    expect(mapPoint(1000, 500, { left: 0, top: 0, width: 1000, height: 500 }, frame)).toEqual({ x: 1000, y: 500 });
  });

  // Invariant: letterbox bars are not part of the page: clicks there are dropped, the image corner maps to page 0,0.
  it('accounts for letterboxing and drops points in the bars', () => {
    const box = { left: 10, top: 20, width: 1000, height: 1000 }; // image drawn 1000x500, centred vertically with 250px bars
    expect(mapPoint(10, 20 + 250, box, frame)).toEqual({ x: 0, y: 0 });
    expect(mapPoint(10 + 500, 20 + 500, box, frame)).toEqual({ x: 500, y: 250 });
    expect(mapPoint(10 + 500, 20 + 100, box, frame)).toBeNull();
    expect(mapPoint(10 + 500, 20 + 900, box, frame)).toBeNull();
  });

  // Invariant: pillarbox bars on the sides are dropped too.
  it('drops points left and right of a pillarboxed image', () => {
    const box = { left: 0, top: 0, width: 1000, height: 250 }; // image drawn 500x250, bars of 250 each side
    expect(mapPoint(100, 100, box, frame)).toBeNull();
    expect(mapPoint(500, 125, box, frame)).toEqual({ x: 500, y: 250 });
  });

  // Invariant: with no frame or an empty box nothing is mapped (no division by zero).
  it('returns null for degenerate geometry', () => {
    expect(mapPoint(1, 1, { left: 0, top: 0, width: 0, height: 0 }, frame)).toBeNull();
    expect(mapPoint(1, 1, { left: 0, top: 0, width: 10, height: 10 }, { imageWidth: 0, imageHeight: 0, meta })).toBeNull();
  });
});

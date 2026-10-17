/**
 * The pixel diff mode's picture and count (#114, M1/M5).
 *
 * `pixelmatch` compares the part both images cover; anything only one of
 * them covers counts as changed, since the two are aligned top-left at
 * actual size. The picture is the after image in greyscale, faded toward
 * `fade` so it reads as context, with every changed pixel painted `tint`.
 * Pure over raw RGBA, so it runs in node as well as on canvas `ImageData`.
 */
import pixelmatch from 'pixelmatch';
import type { Pixels, Rgb } from './types';

export interface PixelDiffOptions {
  /** How different two pixels must be to count, 0–1; pixelmatch's own default is 0.1. */
  readonly threshold: number;
  /** The colour a changed pixel is painted. */
  readonly tint: Rgb;
  /** The colour the unchanged after image is faded toward (the card's background). */
  readonly fade: Rgb;
}

export interface PixelDiff {
  /** max(width) × max(height), aligned top-left. */
  readonly image: Pixels;
  /** Pixels that differ, including every pixel outside the overlap. */
  readonly changed: number;
  readonly total: number;
}

/** How much of the after image shows through the fade. */
const GHOST = 0.3;

export function pixelDiff(before: Pixels, after: Pixels, { threshold, tint, fade }: PixelDiffOptions): PixelDiff {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const overlapWidth = Math.min(before.width, after.width);
  const overlapHeight = Math.min(before.height, after.height);
  const total = width * height;

  // pixelmatch only takes equal sizes, so it sees the overlap, and draws just
  // the changed pixels (a mask) for the colours to be laid in below.
  const mask = new Uint8ClampedArray(overlapWidth * overlapHeight * 4);
  const inOverlap = overlapWidth * overlapHeight > 0
    ? pixelmatch(crop(before, overlapWidth, overlapHeight), crop(after, overlapWidth, overlapHeight), mask,
      overlapWidth, overlapHeight, { threshold, diffMask: true, includeAA: false })
    : 0;

  const data = new Uint8ClampedArray(total * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const inside = x < overlapWidth && y < overlapHeight;
      if (!inside || mask[(y * overlapWidth + x) * 4 + 3] > 0) {
        paint(data, out, tint[0], tint[1], tint[2]);
      } else {
        const at = (y * after.width + x) * 4;
        const d = after.data;
        const grey = 0.299 * d[at] + 0.587 * d[at + 1] + 0.114 * d[at + 2];
        const k = GHOST * (d[at + 3] / 255);
        paint(data, out, mix(fade[0], grey, k), mix(fade[1], grey, k), mix(fade[2], grey, k));
      }
    }
  }

  return {
    image: { width, height, data },
    changed: inOverlap + (total - overlapWidth * overlapHeight),
    total,
  };
}

/** The top-left `width` × `height` of an image, as its own buffer. */
function crop(image: Pixels, width: number, height: number): Uint8ClampedArray {
  if (image.width === width && image.height === height) return image.data;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = y * image.width * 4;
    out.set(image.data.subarray(start, start + width * 4), y * width * 4);
  }
  return out;
}

function paint(data: Uint8ClampedArray, at: number, r: number, g: number, b: number): void {
  data[at] = r;
  data[at + 1] = g;
  data[at + 2] = b;
  data[at + 3] = 255;
}

function mix(from: number, to: number, k: number): number {
  return from + (to - from) * k;
}

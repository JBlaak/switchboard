/**
 * The small shapes the image-compare engine and its modes share (#112).
 *
 * Kept apart from the components so the pure modules (viewport, pixel diff,
 * metadata) can be imported in node without React.
 */

/**
 * How an image card's content is placed in its frame: drawn at `scale` times
 * its natural size, with its top-left corner at (`x`, `y`) in frame pixels.
 * One per card, shared by both sides and every mode.
 */
export interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

/** What sits behind the image: a checkerboard shows transparency; light and dark are flat. */
export type Background = 'checkerboard' | 'light' | 'dark';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Raw RGBA pixels, four bytes a pixel, row by row; the shape of an `ImageData`. */
export interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** A colour as 0–255 channels. */
export type Rgb = readonly [number, number, number];

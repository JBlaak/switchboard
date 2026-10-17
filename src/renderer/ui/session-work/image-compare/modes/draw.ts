/**
 * Drawing raw pixels and reading colours off the page, for the overlay modes
 * (#116). The DOM side of `overlay.ts`.
 */
import { parseCssColor } from './overlay';
import type { Background, Pixels, Rgb } from '../types';

/** Size `canvas` to `pixels` and paint them, one canvas pixel per image pixel. */
export function drawPixels(canvas: HTMLCanvasElement, pixels: Pixels): void {
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  if (pixels.width === 0 || pixels.height === 0) return;
  // ImageData wants a buffer of its own; a view onto a larger one is copied.
  const data = new Uint8ClampedArray(pixels.data);
  canvas.getContext('2d')?.putImageData(new ImageData(data, pixels.width, pixels.height), 0, 0);
}

/**
 * The flat colour behind a background, as the stage draws it: the fixed light
 * and dark stage tokens, and for the checkerboard the raised surface its
 * squares sit on.
 */
const BACKGROUND_TOKEN: Record<Background, string> = {
  checkerboard: '--sb-bg-raised',
  light: '--sb-stage-light',
  dark: '--sb-stage-dark',
};

/** A colour custom property as resolved at `el`, or `fallback` when it is unset or unreadable. */
export function tokenColor(el: Element, token: string, fallback: Rgb): Rgb {
  return parseCssColor(getComputedStyle(el).getPropertyValue(token)) ?? fallback;
}

export function backgroundColor(el: Element, background: Background): Rgb {
  return tokenColor(el, BACKGROUND_TOKEN[background], background === 'dark' ? [0, 0, 0] : [255, 255, 255]);
}

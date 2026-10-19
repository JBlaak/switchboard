/**
 * Right-click on an image card's stage copies an image to the clipboard.
 *
 * Which one: in side-by-side (and a card with a single side) the side under
 * the pointer; in swipe the side of the divider it is on; in blink the side
 * showing; in onion skin and pixel diff, where both are drawn at once, the
 * after. It goes out as a PNG of the first frame, whatever the format, so an
 * SVG lands as the pixels it was drawn at.
 */
import { drawPixels } from './modes/draw';
import type { ImageMode, LoadedImage } from './modes/types';

export type Side = 'before' | 'after';

/** The side to copy in `mode`, given the side the pointer was over, when the mode tells them apart there. */
export function copiedSide(mode: ImageMode, blink: Side, pointed: Side | null): Side {
  switch (mode) {
    case 'side-by-side':
    case 'swipe':
      return pointed ?? 'after';
    case 'blink':
      return blink;
    case 'onion':
    case 'pixel-diff':
      return 'after';
  }
}

/** The side a right-click on `target` at `clientX` was over: a side's own stage, or a side of the swipe divider. */
export function pointedSide(target: Element, clientX: number): Side | null {
  const side = target.closest<HTMLElement>('[data-side]')?.dataset.side;
  if (side === 'before' || side === 'after') return side;
  const divider = target.closest('.sw-swipe')?.querySelector('.sw-swipe-divider');
  if (!divider) return null;
  return clientX < divider.getBoundingClientRect().left ? 'before' : 'after';
}

/** Copy `image`'s first frame to the clipboard as a PNG. */
export async function copyImage(image: LoadedImage): Promise<void> {
  const canvas = document.createElement('canvas');
  drawPixels(canvas, image.pixels());
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (blob) await window.api.writeClipboardImage(new Uint8Array(await blob.arrayBuffer()));
}

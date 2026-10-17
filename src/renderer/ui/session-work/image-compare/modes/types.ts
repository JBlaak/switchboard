/**
 * What every image-compare mode is handed by its card (#112).
 *
 * The card (#115) loads both sides, owns the view, the background and the
 * blink side, and draws whichever mode is picked; each mode draws into its
 * own `ImageStage` and passes the stage's frame size back, so the card can fit
 * the view to it.
 */
import type { Background, Pixels, Size, View } from '../types';

export type ImageMode = 'side-by-side' | 'swipe' | 'onion' | 'blink' | 'pixel-diff';

/** In toolbar order, which is also the order of the `1`–`5` keys. */
export const IMAGE_MODES: readonly ImageMode[] = ['side-by-side', 'swipe', 'onion', 'blink', 'pixel-diff'];

/** One side of an image card, decoded. */
export interface LoadedImage {
  /** A blob URL the card owns and revokes. */
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** More than one frame; the overlay modes compare the first. */
  readonly animated: boolean;
  /** The first frame's pixels, drawn on first call and kept. */
  pixels(): Pixels;
}

export interface ModeProps {
  readonly before: LoadedImage;
  readonly after: LoadedImage;
  readonly view: View;
  onView(view: View): void;
  /** Passed straight to the mode's `ImageStage`. */
  onFrameSize(frame: Size): void;
  readonly background: Background;
  readonly blink: 'before' | 'after';
  onBlink(): void;
}

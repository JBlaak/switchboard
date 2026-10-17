/**
 * Which component draws each image-compare mode (#112).
 */
import type { JSX } from 'react';
import { Blink } from './Blink';
import { Onion } from './Onion';
import { PixelDiff } from './PixelDiff';
import { SideBySide } from './SideBySide';
import { Swipe } from './Swipe';
import type { ImageMode, ModeProps } from './types';

export type ModeView = (props: ModeProps) => JSX.Element;

const MODE_VIEWS: Record<ImageMode, ModeView> = {
  'side-by-side': SideBySide,
  swipe: Swipe,
  onion: Onion,
  blink: Blink,
  'pixel-diff': PixelDiff,
};

/** The component that draws `mode`. */
export function modeView(mode: ImageMode): ModeView {
  return MODE_VIEWS[mode];
}

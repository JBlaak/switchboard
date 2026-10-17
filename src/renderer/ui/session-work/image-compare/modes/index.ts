/**
 * Which component draws each image-compare mode (#112).
 *
 * A mode is registered here once it is built; until then the card falls back
 * to side-by-side for it, so the toolbar can offer all five from the start.
 */
import type { JSX } from 'react';
import { SideBySide } from './SideBySide';
import type { ImageMode, ModeProps } from './types';

export type ModeView = (props: ModeProps) => JSX.Element;

const MODE_VIEWS: Partial<Record<ImageMode, ModeView>> = {
  'side-by-side': SideBySide,
};

/** The component that draws `mode`; side-by-side for a mode not built yet. */
export function modeView(mode: ImageMode): ModeView {
  return MODE_VIEWS[mode] ?? SideBySide;
}

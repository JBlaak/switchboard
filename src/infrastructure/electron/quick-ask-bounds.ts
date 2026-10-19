/**
 * Where the Quick Ask pop-up goes (B2): centred on the display the cursor is
 * on, with the slab's top edge a quarter of the way down it.
 *
 * Pure geometry, so it is tested without a display.
 */

/**
 * The window: a still transparent area, larger than the slab, that the glass
 * moves in (G3). Wide enough for the Playful open, whose stretch overshoots
 * the slab's 640 px to about 750 px (#150).
 */
export const QUICK_ASK_SIZE = { width: 800, height: 460 } as const;

/** How far down the window the slab starts (the pop-up's stylesheet sets the same). */
export const SLAB_TOP = 20;

export interface Area { x: number; y: number; width: number; height: number }

/** The window's bounds on a display whose work area is `area`. */
export function quickAskBounds(area: Area): Area {
  const { width, height } = QUICK_ASK_SIZE;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + area.height / 4 - SLAB_TOP),
    width,
    height,
  };
}

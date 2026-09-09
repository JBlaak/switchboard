/**
 * Remembering where the window was.
 *
 * Restoring a size is easy; restoring a *position* is not, because the display
 * it was on may be gone — a laptop undocked from an external monitor would
 * otherwise reopen its window somewhere unreachable. So the position is only
 * restored when some current display still contains it.
 */
import type { BrowserWindow, Display } from 'electron';
import type { WindowBounds } from '../../domain/settings/settings';

export const DEFAULT_BOUNDS = { width: 1400, height: 900 };
export const MIN_BOUNDS = { minWidth: 800, minHeight: 500 };

/**
 * How far off a display's top-left corner a saved position may be and still
 * count as on it — a window can be dragged slightly off the top or left edge.
 */
const OFF_SCREEN_TOLERANCE = 100;

export interface RestorableBounds {
  width: number;
  height: number;
  position: { x: number; y: number } | null;
}

/** Is this saved position on a display that still exists? */
export function isPositionVisible(
  position: { x: number; y: number },
  displays: readonly Display[],
): boolean {
  return displays.some(({ bounds }) =>
    position.x >= bounds.x - OFF_SCREEN_TOLERANCE &&
    position.x < bounds.x + bounds.width &&
    position.y >= bounds.y - OFF_SCREEN_TOLERANCE &&
    position.y < bounds.y + bounds.height);
}

/** What to open the window at, given what was saved and what displays exist. */
export function restorableBounds(
  saved: WindowBounds | undefined,
  displays: readonly Display[],
): RestorableBounds {
  if (!saved?.width || !saved.height) {
    return { ...DEFAULT_BOUNDS, position: null };
  }
  const position = (saved.x != null && saved.y != null && isPositionVisible({ x: saved.x, y: saved.y }, displays))
    ? { x: saved.x, y: saved.y }
    : null;
  return { width: saved.width, height: saved.height, position };
}

/** The bounds to save, or null when the window is in no state to be measured. */
export function boundsToSave(window: BrowserWindow): WindowBounds | null {
  if (window.isDestroyed() || window.isMinimized()) return null;
  const { x, y, width, height } = window.getBounds();
  return { x, y, width, height };
}

/**
 * The zoom/pan model behind an image card (#114): pure functions from a
 * `View`, the frame it is drawn in and the content's natural size to the next
 * `View`. `ImageStage` turns gestures into these calls; the card keeps the
 * result, so every mode and both sides move together.
 */
import type { Point, Size, View } from './types';

export type { View } from './types';

/** The furthest out a zoom goes, unless fitting the content needs smaller. */
export const MIN_SCALE = 0.1;
/** The furthest in a zoom goes. */
export const MAX_SCALE = 32;
/** From this scale on each image pixel is big enough to outline. */
export const GRID_SCALE = 8;
/** How much of the content a pan always leaves in the frame, in frame pixels. */
const PAN_MARGIN = 32;

/**
 * The view a card opens at: the content fitted to the frame's width but never
 * upscaled past 1:1, centred in whatever room is left.
 */
export function fitView(frame: Size, content: Size): View {
  const scale = content.width > 0 ? Math.min(1, frame.width / content.width) : 1;
  return {
    scale,
    x: Math.max(0, (frame.width - content.width * scale) / 2),
    y: Math.max(0, (frame.height - content.height * scale) / 2),
  };
}

/**
 * Zoom by `factor` about `point` (in frame pixels): the content pixel under
 * the point stays under it. The scale is held between the fit scale (or
 * `MIN_SCALE`, whichever is smaller) and `MAX_SCALE`; given the frame and
 * content, the result is also kept in the frame as `panBy` does.
 */
export function zoomAt(view: View, factor: number, point: Point, frame?: Size, content?: Size): View {
  const floor = frame && content ? Math.min(MIN_SCALE, fitView(frame, content).scale) : MIN_SCALE;
  const scale = clamp(view.scale * factor, floor, MAX_SCALE);
  const k = scale / view.scale;
  const next = {
    scale,
    x: point.x - (point.x - view.x) * k,
    y: point.y - (point.y - view.y) * k,
  };
  return frame && content ? keepInFrame(next, frame, content) : next;
}

/** Move the content by (`dx`, `dy`), never so far that it leaves the frame. */
export function panBy(view: View, dx: number, dy: number, frame: Size, content: Size): View {
  return keepInFrame({ scale: view.scale, x: view.x + dx, y: view.y + dy }, frame, content);
}

/**
 * Double-click: from the fitted view to 1:1 with the clicked pixel kept under
 * the cursor, and from anywhere else back to fit.
 */
export function toggleFitActual(view: View, point: Point, frame: Size, content: Size): View {
  const fit = fitView(frame, content);
  return sameView(view, fit) ? zoomAt(view, 1 / view.scale, point, frame, content) : fit;
}

/** Whether the pixel grid is drawn over the content. */
export function showsGrid(view: View): boolean {
  return view.scale >= GRID_SCALE;
}

/**
 * Keep at least `PAN_MARGIN` of the content (or all of it, when it is
 * smaller) inside the frame on each axis.
 */
function keepInFrame(view: View, frame: Size, content: Size): View {
  const width = content.width * view.scale;
  const height = content.height * view.scale;
  const mx = Math.min(PAN_MARGIN, width);
  const my = Math.min(PAN_MARGIN, height);
  return {
    scale: view.scale,
    x: clamp(view.x, mx - width, frame.width - mx),
    y: clamp(view.y, my - height, frame.height - my),
  };
}

/** Equal up to float noise: a view that went out and back in is still "fit". */
function sameView(a: View, b: View): boolean {
  return Math.abs(a.scale - b.scale) < 1e-6 && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

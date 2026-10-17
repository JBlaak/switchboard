/**
 * The pure arithmetic behind the overlay modes (#116, M1–M5): the shared
 * content size, the swipe divider under zoom, telling a click from a drag,
 * the pixel diff's summary line and reading a CSS colour as channels.
 *
 * Kept free of React and the DOM, so it is unit-tested in node.
 */
import type { Point, Rgb, Size, View } from '../types';

/**
 * The stage content for two images aligned top-left at actual size (M1): the
 * larger of the two on each axis.
 */
export function contentSize(before: Size, after: Size): Size {
  return { width: Math.max(before.width, after.width), height: Math.max(before.height, after.height) };
}

// ── Swipe ──

/** Where the divider starts, in content pixels: halfway across the wider image (M2). */
export function initialDivider(content: Size): number {
  return content.width / 2;
}

/**
 * Where a divider held at content x `divider` lands in the frame. The handle
 * is drawn there at screen size, so it stays put under zoom without growing.
 */
export function dividerOnScreen(divider: number, view: View): number {
  return view.x + divider * view.scale;
}

/**
 * The divider after the pointer moved `dx` frame pixels from where a drag
 * started: a screen move is worth `1 / scale` content pixels. It never leaves
 * the content.
 */
export function dragDivider(start: number, dx: number, view: View, content: Size): number {
  return clamp(start + dx / view.scale, 0, content.width);
}

// ── Blink ──

/** How far a pointer may move between down and up and still be a click, not a pan. */
export const CLICK_SLOP = 4;

/** Whether a press released at `end` is a click rather than the end of a drag. */
export function isClick(start: Point, end: Point): boolean {
  return Math.hypot(end.x - start.x, end.y - start.y) <= CLICK_SLOP;
}

// ── Pixel diff ──

/**
 * The line under the pixel diff (M5): `3.2% changed (14,201 px)`, or
 * `Pixels identical` when nothing differs. A share that rounds to 0% or 100%
 * without being either says `<0.1%` or `>99.9%`, so a single pixel is never
 * reported as no change.
 */
export function describeChange(changed: number, total: number): string {
  if (changed === 0) return 'Pixels identical';
  const pct = (changed / total) * 100;
  const shown = changed === total ? '100%'
    : pct < 0.05 ? '<0.1%'
      : pct >= 99.95 ? '>99.9%'
        : `${pct.toFixed(1)}%`;
  return `${shown} changed (${changed.toLocaleString('en-US')} px)`;
}

/**
 * A computed CSS colour as channels: `#rgb`, `#rrggbb` (alpha digits are
 * ignored), or `rgb()` / `rgba()` in comma or space syntax. Custom properties
 * come back from `getComputedStyle` as written, so a token is usually hex.
 */
export function parseCssColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1];
    const short = digits.length <= 4;
    const channel = (i: number): number => parseInt(short ? digits[i] + digits[i] : digits.slice(i * 2, i * 2 + 2), 16);
    return [channel(0), channel(1), channel(2)];
  }

  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(text);
  if (fn) {
    const [r, g, b] = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if ([r, g, b].every((c) => Number.isFinite(c))) {
      const channel = (c: number): number => clamp(Math.round(c), 0, 255);
      return [channel(r), channel(g), channel(b)];
    }
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

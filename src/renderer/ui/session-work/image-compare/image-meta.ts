/**
 * The metadata line over an image card (#114, C2):
 * `1024×768 → 2048×1536 · 48 KB → 112 KB · PNG`.
 *
 * What didn't change is written once, and an added or deleted image shows
 * only the side it has.
 */

/** One side's measurements, once it has decoded. */
export interface ImageSide {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** `format` is the file's `ImageFormat` (`png`, `jpeg`, …), shown in capitals. */
export function describeImages(format: string, before?: ImageSide | null, after?: ImageSide | null): string {
  const parts: string[] = [];
  const size = change(before && dimensions(before), after && dimensions(after));
  if (size) parts.push(size);
  const bytes = change(before && formatBytes(before.bytes), after && formatBytes(after.bytes),
    before && after ? before.bytes === after.bytes : false);
  if (bytes) parts.push(bytes);
  parts.push(format.toUpperCase());
  return parts.join(' · ');
}

/** A file size the way Finder writes it: `512 B`, `4.2 KB`, `48 KB`, `1.5 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${shown} ${units[unit]}`;
}

function dimensions(side: ImageSide): string {
  return `${side.width}×${side.height}`;
}

/** `a → b`, or one of them when the other is missing or they are the same. */
function change(before: string | null | undefined, after: string | null | undefined, same = before === after): string | null {
  if (before && after) return same ? after : `${before} → ${after}`;
  return before || after || null;
}

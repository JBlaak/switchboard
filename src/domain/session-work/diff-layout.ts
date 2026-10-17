/**
 * Laying a parsed file diff out as rows, unified or side by side.
 *
 * The parser keeps a hunk's lines in the order the diff wrote them. Unified,
 * that is the order they are drawn in. Side by side, each run of deleted lines
 * and the run of added lines that follows it are one change, and are drawn
 * next to each other, the first deletion beside the first addition, and so
 * on; the shorter side is padded with blank cells so the next unchanged line
 * lines up again on both sides.
 */
import type { DiffHunk, DiffLine, FileDiff } from './model';

/** A row of the unified view: a hunk's header, or one line. */
export type UnifiedRow =
  | { kind: 'hunk'; hunk: DiffHunk }
  | { kind: 'line'; line: DiffLine };

/**
 * A row of the split view: a hunk's header, or the old side and the new side
 * of one line. An unchanged line is the same line on both sides; a side with
 * nothing to show is null, drawn as a blank cell.
 */
export type SplitRow =
  | { kind: 'hunk'; hunk: DiffHunk }
  | { kind: 'pair'; left: DiffLine | null; right: DiffLine | null };

/** One side-by-side pair of a hunk's lines. */
export interface LinePair {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** `@@ -12,7 +12,9 @@ section`, as git wrote it. */
export function hunkHeader(hunk: DiffHunk): string {
  const range = (start: number, count: number) => (count === 1 ? String(start) : `${start},${count}`);
  const head = `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@`;
  return hunk.section ? `${head} ${hunk.section}` : head;
}

/**
 * Pair a hunk's lines for the split view.
 *
 * A change is a run of lines that are not context. Its deletions go on the
 * left and its additions on the right, in order, row by row; whichever side
 * runs out first is padded with nulls. A context line sits on both sides. An
 * addition that comes before the deletions of its change (some tools write
 * them that way) still pairs with them.
 */
export function pairLines(lines: readonly DiffLine[]): LinePair[] {
  const pairs: LinePair[] = [];
  let deleted: DiffLine[] = [];
  let added: DiffLine[] = [];

  const flush = () => {
    const rows = Math.max(deleted.length, added.length);
    for (let i = 0; i < rows; i++) pairs.push({ left: deleted[i] ?? null, right: added[i] ?? null });
    deleted = [];
    added = [];
  };

  for (const line of lines) {
    if (line.kind === 'delete') deleted.push(line);
    else if (line.kind === 'add') added.push(line);
    else {
      flush();
      pairs.push({ left: line, right: line });
    }
  }
  flush();
  return pairs;
}

/** A file's rows, unified: each hunk's header followed by its lines. */
export function unifiedRows(file: Pick<FileDiff, 'hunks'>): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const hunk of file.hunks) {
    rows.push({ kind: 'hunk', hunk });
    for (const line of hunk.lines) rows.push({ kind: 'line', line });
  }
  return rows;
}

/** A file's rows, side by side: each hunk's header followed by its paired lines. */
export function splitRows(file: Pick<FileDiff, 'hunks'>): SplitRow[] {
  const rows: SplitRow[] = [];
  for (const hunk of file.hunks) {
    rows.push({ kind: 'hunk', hunk });
    for (const pair of pairLines(hunk.lines)) rows.push({ kind: 'pair', ...pair });
  }
  return rows;
}

/** How many digits the widest line number of a file takes, for its gutters. */
export function lineNumberDigits(file: Pick<FileDiff, 'hunks'>): number {
  let widest = 1;
  for (const hunk of file.hunks) {
    widest = Math.max(widest, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines);
  }
  return String(widest).length;
}

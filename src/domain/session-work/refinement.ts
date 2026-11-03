/**
 * A finer reading of one file's diff, from OmniDiff (`omnidiff --mode json`).
 *
 * git's diff says which lines changed. OmniDiff parses both sides and says
 * which parts of them changed: the `* item.quantity` added to a line, the
 * `let` that became `const`, an expression that only moved. The page keeps
 * git's lines (they are what GitHub's comments anchor to) and paints these
 * marks inside the changed ones. A file with no refinement is drawn as before.
 */

/** What happened to a marked stretch of a line, in OmniDiff's words. */
export type ChangeKind = 'insert' | 'delete' | 'update' | 'move';

/**
 * One marked stretch of one line. Columns count UTF-16 code units in the
 * line's text as `DiffLine.text` holds it (no trailing newline): `start` up
 * to, not including, `end`.
 */
export interface ChangeMark {
    start: number;
    end: number;
    kind: ChangeKind;
    /** For a move: the 1-based line on the other side it moved from or to. */
    otherLine?: number;
}

/** The file's overall shape, when OmniDiff names one. */
export type RefinementSummary =
    'no_changes' | 'new_file' | 'deleted_file' | 'whitespace_only' | 'comment_only' | 'refactor_moved_only';

export interface FileRefinement {
    summary: RefinementSummary | null;
    /** Marks by 1-based line number in the old file, each line's in column order. */
    before: Record<number, ChangeMark[]>;
    /** Marks by 1-based line number in the new file, each line's in column order. */
    after: Record<number, ChangeMark[]>;
}

const KINDS: readonly ChangeKind[] = ['insert', 'delete', 'update', 'move'];

const SUMMARIES: readonly RefinementSummary[] = [
    'no_changes',
    'new_file',
    'deleted_file',
    'whitespace_only',
    'comment_only',
    'refactor_moved_only',
];

/** A stretch of a file in OmniDiff's terms: 0-based rows, UTF-8 byte columns, end exclusive. */
interface OmnidiffRange {
    startRow: number;
    startColumn: number;
    endRow: number;
    endColumn: number;
}

interface OmnidiffHunk {
    kind: ChangeKind;
    range: OmnidiffRange;
    moveTarget: OmnidiffRange | null;
}

/**
 * OmniDiff's JSON (`omnidiff --mode json --minimal`) as marks on the lines of
 * each side; null for anything it cannot place: a binary pair, a shape it
 * does not know, a range that runs backwards.
 *
 * `beforeText` and `afterText` are the two files exactly as OmniDiff read
 * them: its columns are UTF-8 byte offsets within a row, and each is turned
 * into a UTF-16 column of that row's text. A range over several rows becomes
 * a mark on each; one that ends at column 0 of a row marks nothing there. A
 * row's trailing `\r` (a CRLF file) is never marked, though it stays in the
 * text the columns count, as it does in git's lines.
 */
export function refinementFromOmnidiff(json: unknown, beforeText: string, afterText: string): FileRefinement | null {
    if (!isObject(json) || json.binary === true) return null;
    const beforeHunks = hunksOf(json.before);
    const afterHunks = hunksOf(json.after);
    if (!beforeHunks || !afterHunks) return null;
    const summary = SUMMARIES.find((known) => known === json.summary) ?? null;
    return {
        summary,
        before: marksOf(beforeHunks, beforeText.split('\n')),
        after: marksOf(afterHunks, afterText.split('\n')),
    };
}

function marksOf(hunks: OmnidiffHunk[], rows: string[]): Record<number, ChangeMark[]> {
    const marks: Record<number, ChangeMark[]> = {};
    for (const hunk of hunks) {
        const {startRow, startColumn, endRow, endColumn} = hunk.range;
        const otherLine = hunk.kind === 'move' && hunk.moveTarget ? hunk.moveTarget.startRow + 1 : undefined;
        for (let row = startRow; row <= endRow && row < rows.length; row++) {
            const text = rows[row];
            const limit = text.endsWith('\r') ? text.length - 1 : text.length;
            const start = Math.min(row === startRow ? utf16Column(text, startColumn, 'floor') : 0, limit);
            const end = Math.min(row === endRow ? utf16Column(text, endColumn, 'ceil') : limit, limit);
            if (end <= start) continue;
            const mark: ChangeMark = {start, end, kind: hunk.kind};
            if (otherLine !== undefined) mark.otherLine = otherLine;
            (marks[row + 1] ??= []).push(mark);
        }
    }
    for (const line of Object.values(marks)) line.sort((a, b) => a.start - b.start || a.end - b.end);
    return marks;
}

/**
 * The UTF-16 column of a UTF-8 byte offset in `text`. An offset inside a
 * character rounds to its start (`floor`) or its end (`ceil`); one past the
 * end is the end.
 */
function utf16Column(text: string, byteOffset: number, round: 'floor' | 'ceil'): number {
    let bytes = 0;
    let column = 0;
    while (column < text.length) {
        const point = text.codePointAt(column) as number;
        const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
        if (bytes + size > byteOffset) {
            if (bytes === byteOffset || round === 'floor') return column;
            return column + (point > 0xffff ? 2 : 1);
        }
        bytes += size;
        column += point > 0xffff ? 2 : 1;
    }
    return column;
}

function hunksOf(side: unknown): OmnidiffHunk[] | null {
    if (!isObject(side) || !Array.isArray(side.hunks)) return null;
    const hunks: OmnidiffHunk[] = [];
    for (const raw of side.hunks) {
        if (!isObject(raw)) return null;
        const kind = KINDS.find((known) => known === raw.operation);
        const range = rangeOf(raw.range);
        if (!kind || !range) return null;
        const moveTarget = raw.move_target === undefined ? null : rangeOf(raw.move_target);
        if (raw.move_target !== undefined && !moveTarget) return null;
        hunks.push({kind, range, moveTarget});
    }
    return hunks;
}

function rangeOf(raw: unknown): OmnidiffRange | null {
    if (!isObject(raw)) return null;
    const {start_row, start_column, end_row, end_column} = raw;
    if (![start_row, start_column, end_row, end_column].every(isCount)) return null;
    const range = {
        startRow: start_row as number,
        startColumn: start_column as number,
        endRow: end_row as number,
        endColumn: end_column as number,
    };
    const backwards =
        range.endRow < range.startRow || (range.endRow === range.startRow && range.endColumn < range.startColumn);
    return backwards ? null : range;
}

function isCount(value: unknown): boolean {
    return Number.isInteger(value) && (value as number) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

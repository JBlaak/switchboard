/**
 * OmniDiff's marks painted into a diff line's HTML.
 *
 * A line keeps git's tint; the stretches OmniDiff says changed are wrapped in
 * `<mark class="sw-ch is-<kind>">` on top of it. The line's HTML is
 * highlight.js's (`<span class="…">`, `</span>` and escaped text), so a mark
 * that crosses a span is closed before the tag and opened again after it,
 * which keeps every line well formed. Columns count the decoded text: `&lt;`
 * is one character, as `<` is in `DiffLine.text`.
 *
 * Marks never hide anything: an unmarked changed line is drawn as before.
 */
import type {SplitRow, UnifiedRow} from '../../../../domain/session-work/diff-layout';
import type {ChangeMark, FileRefinement} from '../../../../domain/session-work/refinement';

/** Which file a line is from: the old one (`before`) or the new one (`after`). */
export type MarkSide = 'before' | 'after';

/** `html` with `marks` wrapped in `<mark>`s; `html` itself when there are none to draw. */
export function markHighlighted(html: string, marks: readonly ChangeMark[], side: MarkSide): string {
    if (marks.length === 0) return html;
    const stretches = normalise(marks, decodedLength(html));
    if (stretches.length === 0) return html;

    let out = '';
    let column = 0;
    let next = 0;
    let open: ChangeMark | null = null;
    const token = /<[^>]*>|&[^;\s]*;|[\s\S]/g;
    for (let match = token.exec(html); match; match = token.exec(html)) {
        const piece = match[0];
        if (piece.startsWith('<')) {
            if (open) {
                out += '</mark>';
                open = null;
            }
            out += piece;
            continue;
        }
        while (next < stretches.length && stretches[next].end <= column) next++;
        const want = next < stretches.length && stretches[next].start <= column ? stretches[next] : null;
        if (open !== want) {
            if (open) out += '</mark>';
            if (want) out += openTag(want, side);
            open = want;
        }
        out += piece;
        column++;
    }
    if (open) out += '</mark>';
    return out;
}

/** The same for a line with no highlighting: its text escaped, then marked. */
export function markPlain(text: string, marks: readonly ChangeMark[], side: MarkSide): string {
    return markHighlighted(escapeHtml(text), marks, side);
}

/**
 * The HTML of each unified row in `rows[start, end)` with its marks, by
 * offset from `start`: a deleted line takes the old file's marks, an added one
 * the new file's, a context line none. `html` (from `highlightUnifiedRows`)
 * is answered as it is when there is no refinement; an entry stays null (plain
 * text) where it was and the line has no marks.
 */
export function markUnifiedRows(
    rows: readonly UnifiedRow[],
    start: number,
    end: number,
    html: ReadonlyArray<string | null> | null,
    refinement: FileRefinement | null,
): ReadonlyArray<string | null> | null {
    if (!refinement) return html;
    const out: Array<string | null> = html ? [...html] : new Array<string | null>(end - start).fill(null);
    for (let i = start; i < end; i++) {
        const row = rows[i];
        if (row.kind !== 'line') continue;
        const {line} = row;
        if (line.kind === 'delete' && line.oldLine !== null) {
            out[i - start] = marked(line.text, out[i - start], refinement.before[line.oldLine], 'before');
        } else if (line.kind === 'add' && line.newLine !== null) {
            out[i - start] = marked(line.text, out[i - start], refinement.after[line.newLine], 'after');
        }
    }
    return out;
}

/** The same for split rows: deletions on the left take the old file's marks, additions on the right the new file's. */
export function markSplitRows(
    rows: readonly SplitRow[],
    start: number,
    end: number,
    html: {left: ReadonlyArray<string | null>; right: ReadonlyArray<string | null>} | null,
    refinement: FileRefinement | null,
): {left: ReadonlyArray<string | null>; right: ReadonlyArray<string | null>} | null {
    if (!refinement) return html;
    const blank = (): Array<string | null> => new Array<string | null>(end - start).fill(null);
    const left = html ? [...html.left] : blank();
    const right = html ? [...html.right] : blank();
    for (let i = start; i < end; i++) {
        const row = rows[i];
        if (row.kind !== 'pair') continue;
        if (row.left?.kind === 'delete' && row.left.oldLine !== null) {
            left[i - start] = marked(row.left.text, left[i - start], refinement.before[row.left.oldLine], 'before');
        }
        if (row.right?.kind === 'add' && row.right.newLine !== null) {
            right[i - start] = marked(row.right.text, right[i - start], refinement.after[row.right.newLine], 'after');
        }
    }
    return {left, right};
}

function marked(
    text: string,
    html: string | null,
    marks: readonly ChangeMark[] | undefined,
    side: MarkSide,
): string | null {
    if (!marks || marks.length === 0 || wholeLine(text, marks)) return html;
    return html !== null ? markHighlighted(html, marks, side) : markPlain(text, marks, side);
}

/**
 * The marks are an insertion or a deletion of everything on the line but its
 * indentation: the line's own tint already says that, and painting it again
 * only turns a block of new lines into a block of louder new lines.
 */
export function wholeLine(text: string, marks: readonly ChangeMark[]): boolean {
    if (marks.some((mark) => mark.kind !== 'insert' && mark.kind !== 'delete')) return false;
    for (let column = 0; column < text.length; column++) {
        if (/\s/.test(text[column])) continue;
        if (!marks.some((mark) => mark.start <= column && column < mark.end)) return false;
    }
    return true;
}

/** Marks clamped to the line, empty ones dropped, in column order and never overlapping. */
function normalise(marks: readonly ChangeMark[], length: number): ChangeMark[] {
    const clamped = marks
        .map((mark) => ({...mark, start: clamp(mark.start, length), end: clamp(mark.end, length)}))
        .filter((mark) => mark.end > mark.start)
        .sort((a, b) => a.start - b.start);
    const out: ChangeMark[] = [];
    let reached = 0;
    for (const mark of clamped) {
        const start = Math.max(mark.start, reached);
        if (mark.end <= start) continue;
        out.push(start === mark.start ? mark : {...mark, start});
        reached = mark.end;
    }
    return out;
}

function clamp(column: number, length: number): number {
    return Math.min(Math.max(Number.isFinite(column) ? Math.trunc(column) : 0, 0), length);
}

/** How many characters `html`'s text has, an entity counting as one. */
function decodedLength(html: string): number {
    let length = 0;
    const token = /<[^>]*>|&[^;\s]*;|[\s\S]/g;
    for (let match = token.exec(html); match; match = token.exec(html)) {
        if (!match[0].startsWith('<')) length++;
    }
    return length;
}

function openTag(mark: ChangeMark, side: MarkSide): string {
    let tag = `<mark class="sw-ch is-${mark.kind}"`;
    if (mark.kind === 'move' && mark.otherLine !== undefined) {
        const words = side === 'after' ? 'Moved from line' : 'Moved to line';
        tag += ` data-moved-line="${mark.otherLine}" title="${words} ${mark.otherLine}"`;
    }
    return tag + '>';
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

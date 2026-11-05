/**
 * Finding `! <command>` in a line of terminal output, so it can be clicked.
 *
 * Claude suggests shell commands for the user to run as `! git push …`: typed
 * at Claude Code's prompt, the `!` switches it to bash mode and the rest runs
 * in the session. The CLI draws such a command one of three ways, and each
 * tells us where the command ends:
 *
 * - inline code keeps no backticks but gets a colour of its own, so the
 *   command is the run of cells in the `!`'s colour;
 * - a fenced code block is a line of its own, so the command is the rest of
 *   the line;
 * - plain text that kept its backticks ends at the closing backtick.
 *
 * Anything else with a `!` in it ("Done! git is…") is prose and not a link.
 *
 * The CLI wraps long lines itself, so inline code can run on past the end of
 * a line: when its colour reaches the last thing on the line and the next
 * line picks up in the same colour after its indent, the command goes on
 * there, the wrap standing for the space it was broken at.
 */

/** One column of a terminal line. */
export interface BangCell {
    /** The cell's character; ' ' for an empty cell, '' for the right half of a wide one. */
    text: string;
    /** Anything that tells one colour from another; equal styles draw alike. */
    style: string;
    /** Whether the cell is drawn in the terminal's default colours. */
    plain: boolean;
}

/** A cell's place: the line (index into the lines searched) and column. */
export interface BangPosition {
    line: number;
    col: number;
}

/** A clickable command: the cells it covers (inclusive) and what to run. */
export interface BangCommand {
    start: BangPosition;
    end: BangPosition;
    command: string;
}

/** What may stand in front of a code block's line: indent and the CLI's bullets. */
const LINE_LEAD = /^[\s⏺❯⎿•·*>$-]*$/;

export function findBangCommands(lines: readonly (readonly BangCell[])[]): BangCommand[] {
    const found: BangCommand[] = [];
    let y = 0;
    let i = 0;
    while (y < lines.length) {
        const command = i < lines[y].length ? commandAt(lines, y, i) : null;
        if (command) {
            found.push(command);
            ({line: y, col: i} = command.end);
        }
        i++;
        if (i >= lines[y].length) {
            y++;
            i = 0;
        }
    }
    return found;
}

/** The command whose `!` is at `lines[y][i]`, if one is. */
function commandAt(lines: readonly (readonly BangCell[])[], y: number, i: number): BangCommand | null {
    const cells = lines[y];
    if (cells[i].text !== '!' || !startsCommand(cells, i)) return null;
    if (!cells[i].plain && cells[i - 1]?.text !== '`') return styledCommand(lines, y, i);
    let last: number;
    if (cells[i - 1]?.text === '`') {
        const close = cells.findIndex((cell, j) => j > i && cell.text === '`');
        if (close < 0) return null;
        last = close - 1;
    } else if (LINE_LEAD.test(textOf(cells, 0, i - 1))) {
        last = cells.length - 1;
    } else {
        return null;
    }
    last = trimEnd(cells, i, last);
    const command = textOf(cells, i + 1, last).trim();
    return command ? {start: {line: y, col: i}, end: {line: y, col: last}, command} : null;
}

/** Inline code from the `!` at `lines[y][i]`, following its colour across the CLI's wraps. */
function styledCommand(lines: readonly (readonly BangCell[])[], y: number, i: number): BangCommand | null {
    const style = lines[y][i].style;
    const parts: string[] = [];
    let line = y;
    let from = i + 1;
    let end = runEnd(lines[line], i, style);
    for (;;) {
        const cells = lines[line];
        parts.push(textOf(cells, from, end).trim());
        const next = lines[line + 1];
        if (!next || !restIsBlank(cells, end)) break;
        const resume = next.findIndex((cell) => cell.text.trim() !== '');
        if (resume < 0 || next[resume].plain || next[resume].style !== style) break;
        line++;
        from = resume;
        end = runEnd(next, resume, style);
    }
    const command = parts.filter(Boolean).join(' ');
    if (!command) return null;
    return {start: {line: y, col: i}, end: {line, col: trimEnd(lines[line], from, end)}, command};
}

/** The last column of the run of `style` that starts at `from`. */
function runEnd(cells: readonly BangCell[], from: number, style: string): number {
    let last = from;
    while (last + 1 < cells.length && cells[last + 1].style === style) last++;
    return last;
}

function restIsBlank(cells: readonly BangCell[], after: number): boolean {
    return cells.slice(after + 1).every((cell) => cell.text.trim() === '');
}

/** `last`, moved back over blank cells but not past `floor`. */
function trimEnd(cells: readonly BangCell[], floor: number, last: number): number {
    while (last > floor && cells[last].text.trim() === '') last--;
    return last;
}

/** A `!` that starts a word and is followed by a space and then the command. */
function startsCommand(cells: readonly BangCell[], i: number): boolean {
    const before = i > 0 ? cells[i - 1].text : ' ';
    if (before !== '`' && before.trim() !== '') return false;
    return cells[i + 1]?.text === ' ' && (cells[i + 2]?.text ?? ' ').trim() !== '';
}

function textOf(cells: readonly BangCell[], from: number, to: number): string {
    return cells
        .slice(from, to + 1)
        .map((cell) => cell.text)
        .join('');
}

/**
 * The keys that run `command` at Claude Code's prompt, each a write of its
 * own: `!` alone first, so the CLI is in bash mode before the command lands,
 * then the command, then Enter once it has (see `PtySessionPrompter`).
 */
export function bangCommandKeys(command: string): string[] {
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    return ['!', command.replace(/[\x00-\x1f\x7f]/g, ''), '\r'];
}

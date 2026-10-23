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

/** A clickable command: the columns it covers (inclusive) and what to run. */
export interface BangCommand {
  start: number;
  end: number;
  command: string;
}

/** What may stand in front of a code block's line: indent and the CLI's bullets. */
const LINE_LEAD = /^[\s⏺❯⎿•·*>$-]*$/;

export function findBangCommands(cells: readonly BangCell[]): BangCommand[] {
  const found: BangCommand[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].text !== '!' || !startsCommand(cells, i)) continue;
    const before = i > 0 ? cells[i - 1].text : ' ';
    let last: number;
    if (before === '`') {
      const close = cells.findIndex((cell, j) => j > i && cell.text === '`');
      if (close < 0) continue;
      last = close - 1;
    } else if (!cells[i].plain) {
      last = i;
      while (last + 1 < cells.length && cells[last + 1].style === cells[i].style) last++;
    } else if (LINE_LEAD.test(textOf(cells, 0, i - 1))) {
      last = cells.length - 1;
    } else {
      continue;
    }
    while (last > i && cells[last].text.trim() === '') last--;
    const command = textOf(cells, i + 1, last).trim();
    if (command) found.push({ start: i, end: last, command });
    i = last;
  }
  return found;
}

/** A `!` that starts a word and is followed by a space and then the command. */
function startsCommand(cells: readonly BangCell[], i: number): boolean {
  const before = i > 0 ? cells[i - 1].text : ' ';
  if (before !== '`' && before.trim() !== '') return false;
  return cells[i + 1]?.text === ' ' && (cells[i + 2]?.text ?? ' ').trim() !== '';
}

function textOf(cells: readonly BangCell[], from: number, to: number): string {
  return cells.slice(from, to + 1).map(cell => cell.text).join('');
}

/**
 * The keys that run `command` at Claude Code's prompt, each a write of its
 * own: `!` alone first, so the CLI is in bash mode before the command lands,
 * then the command, then Enter once it has (see `PtySessionPrompter`).
 */
export function bangCommandKeys(command: string): string[] {
  return ['!', command.replace(/[\x00-\x1f\x7f]/g, ''), '\r'];
}

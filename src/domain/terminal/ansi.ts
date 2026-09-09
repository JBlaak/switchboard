/**
 * The escape sequences Switchboard writes into a terminal itself.
 *
 * Everything here is chrome rather than output from the process: a banner
 * saying the session ended, a note that a connection dropped. They are written
 * into the scrollback so the reason survives whatever repaints next, and dimmed
 * so they read as the app talking rather than the program.
 */

/** Dim — the default for status the user does not need to act on. */
export const COLOUR_DIM = '\x1b[2m';
/** Yellow — something went wrong but the session is still there. */
export const COLOUR_WARN = '\x1b[33m';
const RESET = '\x1b[0m';

/** Switch the terminal into the alternate screen buffer. */
export const ENTER_ALT_SCREEN = '\x1b[?1049h';
/** Hide the cursor — used after a buffer replay, before the PTY repaints. */
export const HIDE_CURSOR = '\x1b[?25l';

/**
 * One line of status in the scrollback.
 *
 * Opens its own line so it can't land in the middle of whatever the process
 * last printed, and closes it so the next output starts clean.
 */
export function statusBanner(text: string, colour: string = COLOUR_DIM): string {
  return `\r\n${colour}── ${text} ──${RESET}\r\n`;
}

/** The banner shown when a session's process ends. */
export function sessionExitedBanner(exitCode: number): string {
  return statusBanner(`session exited (code ${exitCode})`, exitCode === 0 ? COLOUR_DIM : COLOUR_WARN);
}

/**
 * Drop escape sequences so output can be matched against.
 *
 * Only used where a decision turns on the text a human would see — spotting a
 * trust prompt, waiting for `/stats` to finish — never on anything that reaches
 * a terminal.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[^@-~]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[^[\]].?/g, '');
}

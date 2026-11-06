/**
 * How a prompt is typed into a session's terminal, the way a terminal pastes.
 *
 * As a bracketed paste (`ESC[200~ … ESC[201~`), which the Claude CLI turns on
 * and reads as one block of input. Without the brackets every newline in a
 * multi-line prompt would be an Enter, and the first line would be sent on its
 * own.
 *
 * Enter is a separate write, a moment later. The CLI coalesces a paste before
 * it lands in the input box (long ones become "[Pasted text #1]"), and a `\r`
 * arriving in the same chunk as the closing bracket can be taken as part of
 * the paste, which leaves the prompt sitting in the box unsent. Typed by hand,
 * Enter comes after the paste has landed; the delay does the same.
 *
 * Shared by main's session prompter (Session work) and the renderer's saved
 * prompts (#339), which write through the same pty.
 */

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** How long after the paste Enter is pressed. */
export const SUBMIT_DELAY_MS = 150;

/**
 * The bytes a prompt is pasted as.
 *
 * Inside the brackets only text may appear: an escape (from a CI log's colour
 * codes, say) could close the paste early and have the rest typed as keys,
 * and a carriage return could press Enter half-way. So escapes and other
 * control characters go, and line endings become `\n`, which the CLI keeps as
 * a newline in the message.
 */
export function pasteBytes(prompt: string): string {
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    const text = prompt.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    return PASTE_START + text + PASTE_END;
}

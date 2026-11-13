/**
 * Which keydown is which shortcut: the rules, without acting on any of them.
 *
 * The listeners that act (`app/shortcuts`, the terminal's key handler, the
 * session list's own keydown) live beside the DOM and the store; what a key
 * *means* is decided here, from the event alone, so it is tested in node.
 */

/** Cmd+L puts a cursor in the session list. */
export function isSidebarFocusKey(e: KeyboardEvent): boolean {
    if (e.altKey || e.code !== 'KeyL') return false;
    return e.metaKey && !e.shiftKey && !e.ctrlKey;
}

/** Cmd+S hides or shows the sidebar, wherever the focus is: no text field has a use for it. */
export function isSidebarToggleKey(e: KeyboardEvent): boolean {
    return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyS';
}

/**
 * Cmd+A opens the Projects modal.
 *
 * Except in a text field, where it stays Select All — the picker's own filter
 * among them.
 */
export function isSessionPickerKey(e: KeyboardEvent): boolean {
    return isCommandKey(e, 'KeyA');
}

/** Cmd+E archives the open session, with the same text-field exception. */
export function isArchiveSessionKey(e: KeyboardEvent): boolean {
    return isCommandKey(e, 'KeyE');
}

/**
 * Cmd+Z takes the last archive back while its Undo toast is up (the caller
 * checks that), with the same text-field exception: there it undoes typing.
 */
export function isUndoArchiveKey(e: KeyboardEvent): boolean {
    return isCommandKey(e, 'KeyZ');
}

/**
 * Cmd+, opens the project's settings while its page has the keyboard (#176).
 * Free everywhere else: the app menu has no Settings item to claim it.
 */
export function isProjectSettingsKey(e: KeyboardEvent): boolean {
    return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'Comma';
}

/**
 * Cmd+T opens or closes the Tasks page (#249), wherever the focus is. Only
 * while BlaakTasks is on; the caller checks that.
 */
export function isTasksPageKey(e: KeyboardEvent): boolean {
    return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyT';
}

/** Cmd+I opens or closes the Issue manager page (#415), from anywhere, the terminal included. */
export function isIssueManagerKey(e: KeyboardEvent): boolean {
    return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyI';
}

/** Cmd+B: the Bug manager page (#414), open or closed. */
export function isBugPageKey(e: KeyboardEvent): boolean {
    return e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === 'KeyB';
}

/**
 * Cmd+1 … Cmd+9 send the session on screen its saved prompt on that key
 * (#343): the key's number, or null for any other key. In the terminal too,
 * tray open or not; not while typing in a text field, which keeps the key.
 */
export function savedPromptKey(e: KeyboardEvent): number | null {
    const match = /^Digit([1-9])$/.exec(e.code);
    if (!match || !isCommandKey(e, e.code)) return null;
    return Number(match[1]);
}

/** Cmd plus `code`, unless the key is going into a text field. */
function isCommandKey(e: KeyboardEvent, code: string): boolean {
    if (e.altKey || e.shiftKey || e.ctrlKey || !e.metaKey || e.code !== code) return false;
    const target = e.target as HTMLElement | null;
    if (!target || target.closest('.xterm')) return true;
    return !target.matches(TEXT_FIELD);
}

const TEXT_FIELD = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Cmd+N. */
export function isQuickSessionKey(e: KeyboardEvent): boolean {
    if (e.altKey || e.code !== 'KeyN') return false;
    return e.metaKey && !e.shiftKey && !e.ctrlKey;
}

/**
 * A bare N, while the keyboard is not in a terminal or a text field.
 *
 * Anything that takes typing gets the key as a letter: the terminal, a dialog's
 * filter, a settings input, a rename.
 */
export function isBareQuickSessionKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.code !== 'KeyN') return false;
    const target = e.target as HTMLElement | null;
    if (!target) return true;
    if (target.closest('.xterm')) return false;
    return !target.matches(TEXT_FIELD);
}

// Returns true if the key combo is a session nav shortcut (used by xterm to block without acting)
export function isSessionNavKey(e: KeyboardEvent): boolean {
    return sessionNavDirection(e) !== null;
}

/**
 * Which way a session-navigation key goes: Cmd+Shift+[ and Cmd+Left/Up go
 * back, Cmd+Shift+] and Cmd+Right/Down go on. Null for any other key.
 *
 * On macOS, Shift changes `e.key` to { / }, so the brackets are matched by code.
 */
export function sessionNavDirection(e: KeyboardEvent): -1 | 1 | null {
    if (!e.metaKey || e.altKey) return null;
    if (e.shiftKey) {
        if (e.code === 'BracketLeft') return -1;
        if (e.code === 'BracketRight') return 1;
        return null;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') return -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') return 1;
    return null;
}

/** What a key does while the session list holds the keyboard. */
export type ListCursorKey = 'down' | 'up' | 'activate' | 'rename' | 'archive' | 'newSession' | 'leave';

/**
 * The session list's own keys: the arrows or J and K step, Enter does what a
 * click would, R or F2 renames, E archives, A starts a new session and Escape
 * lets go. The letters are left alone with Cmd, Ctrl or Alt held, so those
 * chords stay free for the app's shortcuts.
 */
export function listCursorKey(e: KeyboardEvent): ListCursorKey | null {
    const chord = e.metaKey || e.ctrlKey || e.altKey;
    switch (e.key) {
        case 'ArrowDown':
            return 'down';
        case 'ArrowUp':
            return 'up';
        case 'j':
            return chord ? null : 'down';
        case 'k':
            return chord ? null : 'up';
        case 'Enter':
            return 'activate';
        case 'r':
        case 'F2':
            return chord ? null : 'rename';
        case 'e':
            return chord ? null : 'archive';
        case 'a':
            return chord ? null : 'newSession';
        case 'Escape':
            return 'leave';
        default:
            return null;
    }
}

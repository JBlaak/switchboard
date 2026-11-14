/**
 * Driving the session list from the keyboard.
 *
 * Cmd+L takes focus out of the terminal and puts a cursor on the row on
 * screen. The arrows (or J and K) move it, Enter does what a click would, R or
 * F2 renames, E archives (a group header archives the whole group; Cmd+E, from
 * anywhere, archives the open session), L lands the row's PR (#436), A (or
 * Cmd+A, from anywhere) starts a new session, and Escape goes back to the
 * terminal.
 *
 * Where the cursor can go is read from the list's layout (`state/list-cursor`):
 * rows, group headers, the foldable section labels and the "more" toggles all take part, in the order the
 * list renders them, and then the rows of the Errands shelf: ↓ past the list's
 * last target walks into the shelf and unfolds it, and ↑ from its first row
 * comes back out. A shelf row takes the same keys as a row. The cursor itself is state, so it survives a redraw, and
 * if what it was on is gone the next arrow simply starts again from the top.
 *
 * The keys are heard on `#sidebar-content`, which is what holds the focus
 * while the cursor is out: the focus, and scrolling the cursor into view,
 * are the parts that stay with the DOM.
 */
import {flushSync} from 'react-dom';
import {sidebarContent} from '../../lib/dom';
import {listCursorKey} from '../../lib/shortcut-keys';
import {getState} from '../../state/app-store';
import {
    cursorTargets,
    liveCursor,
    opensShelf,
    shownTargets,
    startTarget,
    stepCursor,
    targetAfterRemoval,
} from '../../state/list-cursor';
import {openSessions} from '../../state/session-store';
import {openDialog} from '../../ui/dialogs/actions';
import {openPlanPage} from '../../ui/plan-page/actions';
import {openProjectPage} from '../../ui/project-page/actions';
import {
    expandSlugGroup,
    openRow,
    startRename,
    toggleErrandShelf,
    toggleOlder,
    toggleSection,
    toggleSlugGroup,
} from '../../ui/session-list/actions';
import {cursorElement, pressArchive, setListCursor} from '../../ui/session-list/cursor';
import {highlightedSession} from '../../state/main-area-slice';
import {landSessionPullRequest} from '../../ui/merge-manager/land-actions';
import type {CursorTarget} from '../../state/list-cursor';

export {isArchiveSessionKey, isSessionPickerKey, isSidebarFocusKey} from '../../lib/shortcut-keys';

/**
 * Archive the session on screen, the way its row's archive button does.
 *
 * Through the button rather than around it, so the confetti and the slide-out
 * happen here too.
 */
export function archiveActiveSession(): void {
    const onScreen = highlightedSession(getState().mainArea);
    if (!onScreen) return;
    const row = targets().find((t) => (t.kind === 'row' || t.kind === 'errand') && t.sessionId === onScreen);
    if (row) pressArchive(row.name);
}

export function installSidebarKeyboard(): void {
    // Focusable from script only: tabbing should not stop on the whole list.
    sidebarContent.tabIndex = -1;
    sidebarContent.addEventListener('keydown', onKeyDown);
    sidebarContent.addEventListener('focusout', (e: FocusEvent) => {
        // A rename input inside the list keeps the cursor; anywhere else ends it.
        if (sidebarContent.contains(e.relatedTarget as Node | null)) return;
        clearCursor();
    });
}

/** Whether the list itself holds focus — the redraw must not hand it back to the terminal. */
export function isSidebarFocused(): boolean {
    return document.activeElement === sidebarContent;
}

export function focusSidebar(): void {
    const state = getState();
    if (state.toolbar.sidebarCollapsed) return;
    const start = startTarget(state.sessionList, targets(), highlightedSession(state.mainArea));
    if (!start) return;
    sidebarContent.focus({preventScroll: true});
    moveCursorTo(start);
}

function onKeyDown(e: KeyboardEvent): void {
    // Keys typed into a rename input are the input's own.
    if (e.target !== sidebarContent) return;

    const key = listCursorKey(e);
    if (!key) return;
    e.preventDefault();
    switch (key) {
        case 'down':
        case 'up':
            step(key === 'down' ? 1 : -1);
            return;
        case 'activate':
            activateCursor();
            return;
        case 'rename':
            renameAtCursor();
            return;
        case 'archive':
            archiveAtCursor();
            return;
        case 'land':
            landAtCursor();
            return;
        case 'newSession':
            openDialog({kind: 'projectPicker'});
            return;
        case 'leave':
            backToTerminal();
            return;
    }
}

/** What the list renders right now that the cursor could be on. */
function targets(): CursorTarget[] {
    const state = getState();
    return cursorTargets(state.sessionList, state.view.activePtyIds);
}

function currentCursor(): CursorTarget | null {
    return liveCursor(getState().sessionList, targets());
}

function step(direction: -1 | 1): void {
    const next = stepCursor(targets(), currentCursor()?.name ?? null, direction);
    if (next) moveCursorTo(next);
}

/** Enter: what clicking the target would do. */
function activateCursor(): void {
    const cursor = currentCursor();
    if (!cursor) return;
    switch (cursor.kind) {
        case 'row':
            openRow(cursor.name, cursor.sessionId, cursor.groupId);
            return;
        case 'errand':
            openRow(cursor.name, cursor.sessionId);
            return;
        case 'plan':
            openPlanPage(cursor);
            return;
        case 'project':
            openProjectPage(cursor.projectPath);
            return;
        case 'header':
            toggleSlugGroup(cursor.groupId);
            return;
        case 'more':
            expandSlugGroup(cursor.groupId);
            return;
        case 'older':
            toggleOlder();
            return;
        case 'section':
            toggleSection(cursor.tier);
            return;
    }
}

function renameAtCursor(): void {
    const cursor = currentCursor();
    if (cursor?.kind !== 'row' && cursor?.kind !== 'errand') return;
    const {name} = cursor;

    // Committed at once: the input focuses itself as it mounts, and the keys
    // that end the rename are listened for on it.
    flushSync(() => startRename(name));
    const input = document.activeElement;
    if (!input || input === sidebarContent || !sidebarContent.contains(input)) return;

    // Enter or Escape finishes the rename; the list keeps the keyboard after it.
    // The input losing focus has already cleared the cursor, so it goes back on.
    input.addEventListener('keydown', (e: Event) => {
        const {key} = e as KeyboardEvent;
        if (key !== 'Enter' && key !== 'Escape') return;
        setTimeout(() => {
            sidebarContent.focus({preventScroll: true});
            if (targets().some((t) => t.name === name)) moveCursorTo(name);
        });
    });
}

/**
 * Archive what is under the cursor by pressing its own archive button, so the
 * slide-out and confetti are the same as a click. The cursor moves on to the
 * next target before this one is gone.
 */
function archiveAtCursor(): void {
    const cursor = currentCursor();
    if (!cursor || (cursor.kind !== 'row' && cursor.kind !== 'errand' && cursor.kind !== 'header')) return;

    const before = shownTargets(targets());
    // Marks the row (or group) as leaving at once, so it drops out of `after`.
    if (!pressArchive(cursor.name)) return;

    const next = targetAfterRemoval(before, cursor.name, shownTargets(targets()));
    if (next) moveCursorTo(next);
    else clearCursor();
}

/** L: land the PR of the row under the cursor (#436); a row without one says why in the toast. */
function landAtCursor(): void {
    const cursor = currentCursor();
    if (cursor?.kind !== 'row' && cursor?.kind !== 'errand') return;
    void landSessionPullRequest(cursor.sessionId);
}

function backToTerminal(): void {
    clearCursor();
    const onScreen = highlightedSession(getState().mainArea);
    const open = onScreen ? openSessions.get(onScreen) : undefined;
    if (open) open.terminal.focus();
    else sidebarContent.blur();
}

function moveCursorTo(target: string): void {
    // Walking onto a shelf row unfolds the shelf, committed at once so the row
    // is there to scroll into view.
    if (opensShelf(getState().sessionList, targets(), target)) flushSync(() => toggleErrandShelf(true));
    setListCursor(target);
    cursorElement(target)?.scrollIntoView({block: 'nearest'});
}

function clearCursor(): void {
    setListCursor(null);
}

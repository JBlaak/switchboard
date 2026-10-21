/**
 * What the session list's rows do when clicked: every IPC call behind them,
 * each ending in a dispatch or a redraw.
 *
 * The components only call these. Each takes the session by id and looks up
 * the shared row object (`sessionMap`) at the moment of the click, because
 * that is what the rest of the renderer holds — the terminal, the dialogs, the
 * pending registry — and the layout's copy is only what the list showed.
 */
import { loadProjects } from '../../features/sessions/session-list';
import { relayoutSessionList } from './relayout';
import { dispatch, getState } from '../../state/app-store';
import { sessionMap } from '../../state/session-store';
import { renamedName } from '../../state/session-list-layout';
import { bump } from '../../lib/motion/reflow';
import { openResumeDialog } from '../dialogs/actions';
import {
  archiveSessionRow, clearScreen, confirmAndStopSession, openSession,
} from '../../features/sessions/session-actions';
import { pollActiveSessions } from '../../features/sessions/session-poller';
import { celebrateFrom, isLeaving, leave } from './leave';
import type { SessionRow } from '../../../domain/session/session';

// ── Opening and the empty space ──

/** A click on a row: open its session, unless the row is on its way out. */
export function openRow(rowId: string, sessionId: string, groupId?: string): void {
  if (isLeaving(rowId, groupId)) return;
  const session = sessionMap.get(sessionId);
  if (session) void openSession(session);
}

/** Clicking the list anywhere but on a row or a control puts the session away. */
export function clearScreenFromList(target: Element): void {
  if (target.closest(
    '.session-item, .slug-group-header, .slug-group-more, .sessions-more-toggle, button, a, input')) return;
  if (getState().view.activeSessionId) clearScreen();
}

// ── Row buttons ──

/**
 * Pin or unpin, once main has stored it — not optimistically, so the row only
 * moves to its new section when the star really changed.
 *
 * The bump is on the pin that was clicked; the re-sort may move the row, and
 * the element moves with it.
 */
export async function togglePin(sessionId: string, pin: HTMLElement): Promise<void> {
  const session = sessionMap.get(sessionId);
  if (!session) return;
  const { starred } = await window.api.toggleStar(sessionId);
  session.starred = starred;
  // A pin going in pops, one coming out dips.
  bump(pin, starred ? 10 : -4);
  relayoutSessionList({ resort: true });
}

export function stopRow(sessionId: string): void {
  void confirmAndStopSession(sessionId);
}

export function resumeWithConfig(sessionId: string): void {
  const session = sessionMap.get(sessionId);
  if (session) void openResumeDialog(session);
}

/**
 * Archive a row with confetti, sliding it out of this list, or bring one back
 * from the archive.
 *
 * An unarchived row stays where it is: a search lists archived and active
 * sessions alike, so it is still listed afterwards, and a slide-out would
 * leave it collapsed and marked as leaving — invisible even once the search
 * is cleared.
 */
export function toggleArchive(el: HTMLElement, rowId: string, sessionId: string, button: HTMLElement): void {
  const session = sessionMap.get(sessionId);
  if (!session) return;
  if (session.archived) {
    void archiveSessionRow(session, 0).then(() => loadProjects());
    return;
  }
  celebrateFrom(button);
  leave(el, rowId, async () => {
    if (!await archiveSessionRow(session, 1)) return false;
    void pollActiveSessions();
    void loadProjects();
    return true;
  });
}

/** Archive every unarchived session in one slug group, sliding the group out first. */
export function archiveGroup(el: HTMLElement, groupId: string, sessionIds: readonly string[], button: HTMLElement): void {
  if (isLeaving(groupId)) return;
  const sessions = sessionIds
    .map(id => sessionMap.get(id))
    .filter((s): s is SessionRow => !!s && !s.archived);
  if (!sessions.length) return;

  celebrateFrom(button);
  leave(el, groupId, async () => {
    let ok = true;
    for (const session of sessions) {
      // One failure stops the sweep rather than silently skipping a session
      // whose PTY is still running.
      if (!await archiveSessionRow(session, 1)) {
        ok = false;
        break;
      }
    }
    void pollActiveSessions();
    void loadProjects();
    return ok;
  });
}

// ── Links ──

/** A slug group's project label opens its repository (never for a remote: its git lives on another host). */
export function openRepository(projectPath: string): void {
  void window.api.openRepository(projectPath);
}

// ── Folding ──

export function toggleSlugGroup(groupId: string): void {
  if (isLeaving(groupId)) return;
  dispatch({ type: 'slugGroupToggled', id: groupId });
}

/** "+ N more" inside a group: expanding the group is what reveals them. */
export function expandSlugGroup(groupId: string): void {
  dispatch({ type: 'slugGroupExpanded', id: groupId });
}

export function toggleOlder(): void {
  dispatch({ type: 'olderToggled' });
}

// ── Rename ──

export function startRename(rowId: string): void {
  dispatch({ type: 'renameStarted', rowId });
}

export function cancelRename(rowId: string): void {
  dispatch({ type: 'renameEnded', rowId });
}

/** Save what was typed, as the name `renamedName` makes of it. */
export async function finishRename(rowId: string, sessionId: string, typed: string): Promise<void> {
  const session = sessionMap.get(sessionId);
  if (!session) {
    dispatch({ type: 'renameEnded', rowId });
    return;
  }
  const name = renamedName(typed, session);
  await window.api.renameSession(sessionId, name);
  session.name = name;
  dispatch({ type: 'sessionRenamed', sessionId, name });
  dispatch({ type: 'renameEnded', rowId });
}

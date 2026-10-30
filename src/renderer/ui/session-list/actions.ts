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
import { sessionMap, view } from '../../state/session-store';
import { renamedName } from '../../state/session-list-layout';
import { bump } from '../../lib/motion/reflow';
import { openResumeDialog } from '../dialogs/actions';
import {
  archiveSessionRow, clearScreen, confirmAndStopSession, openSession, snoozeSessionRow,
} from '../../features/sessions/session-actions';
import { doze, wakeUp } from '../../lib/motion/sleep';
import { pollActiveSessions } from '../../features/sessions/session-poller';
import { celebrateFrom, isLeaving, leave } from './leave';
import { offerArchiveUndo, sessionOnScreen } from '../archive-undo/actions';
import type { SessionRow } from '../../../domain/session/session';

// ── Opening and the empty space ──

/** A click on a row: open its session, unless the row is on its way out. */
export function openRow(rowId: string, sessionId: string, groupId?: string): void {
  if (isLeaving(rowId, groupId)) return;
  const session = sessionMap.get(sessionId);
  if (session) void openSession(session);
}

/**
 * Clicking the list anywhere but on a row or a control puts away whatever the
 * main area shows, a project included: the empty screen takes its place.
 */
export function clearScreenFromList(target: Element): void {
  if (target.closest(
    '.session-item, .slug-group-header, .slug-group-more, .sessions-more-toggle, button, a, input')) return;
  if (getState().mainArea.route.kind !== 'empty') clearScreen();
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

/**
 * Pin a plan to the top of the list or unpin it, once main has stored it, like
 * a session's pin. Its sessions keep their own stars.
 */
export async function togglePlanPin(projectPath: string, slug: string, pin: HTMLElement): Promise<void> {
  const { pinned } = await window.api.togglePlanPin(projectPath, slug);
  // The same project can be in both cached lists as separate objects.
  for (const project of [...view.cachedProjects, ...view.cachedAllProjects]) {
    if (project.projectPath !== projectPath) continue;
    const others = (project.pinnedPlans ?? []).filter(s => s !== slug);
    project.pinnedPlans = pinned ? [...others, slug] : others;
  }
  bump(pin, pinned ? 10 : -4);
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
  const onScreen = sessionOnScreen();
  leave(el, rowId, async () => {
    if (!await archiveSessionRow(session, 1)) return false;
    offerArchiveUndo([session], [rowId], onScreen);
    void pollActiveSessions();
    void loadProjects();
    return true;
  });
}

/**
 * Snooze a row until `until`, or wake it with null.
 *
 * The moon nods off and the row dozes first, then it slides out like an
 * archived one. While a search is on the row stays: a search lists snoozed
 * sessions, so a slide-out would leave it collapsed and marked as leaving.
 */
export function snoozeRow(el: HTMLElement, rowId: string, sessionId: string, moon: HTMLElement, until: Date | null): void {
  const session = sessionMap.get(sessionId);
  if (!session) return;
  if (!until) {
    wakeUp(moon);
    void snoozeSessionRow(session, null).then(() => relayoutSessionList());
    return;
  }
  const wait = doze(moon, el);
  const save = async (): Promise<boolean> => {
    await snoozeSessionRow(session, until.toISOString());
    relayoutSessionList();
    return true;
  };
  if (getState().view.searchMatchIds !== null) {
    setTimeout(() => void save(), wait);
    return;
  }
  setTimeout(() => leave(el, rowId, save), wait);
}

/** Archive every unarchived session in one slug group, sliding the group out first. */
export function archiveGroup(el: HTMLElement, groupId: string, sessionIds: readonly string[], button: HTMLElement): void {
  if (isLeaving(groupId)) return;
  const sessions = sessionIds
    .map(id => sessionMap.get(id))
    .filter((s): s is SessionRow => !!s && !s.archived);
  if (!sessions.length) return;

  celebrateFrom(button);
  const onScreen = sessionOnScreen();
  leave(el, groupId, async () => {
    let ok = true;
    const archived: SessionRow[] = [];
    for (const session of sessions) {
      // One failure stops the sweep rather than silently skipping a session
      // whose PTY is still running.
      if (!await archiveSessionRow(session, 1)) {
        ok = false;
        break;
      }
      archived.push(session);
    }
    // A failed sweep brings the group back, so only the archived rows are undone.
    offerArchiveUndo(archived, ok ? [groupId] : [], onScreen);
    void pollActiveSessions();
    void loadProjects();
    return ok;
  });
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

/**
 * What the archive's Undo toast does: offering it after an archive here, and
 * taking the archive back. The sequence is in `undo.ts`.
 */
import { dispatch, getState } from '../../state/app-store';
import { highlightedSession } from '../../state/main-area-slice';
import { pendingSessions, sessionMap } from '../../state/session-store';
import { sessionDisplayName } from '../../state/session-list-layout';
import { archiveUndoLabel } from '../../state/archive-undo-slice';
import { archiveSessionRow, openSession } from '../../features/sessions/session-actions';
import { loadProjects } from '../../features/sessions/session-list';
import { undoArchiveWith, type UndoSteps } from './undo';
import type { SessionRow } from '../../../domain/session/session';

/** The session on screen now: an archive takes its view, so Undo needs to know before. */
export function sessionOnScreen(): string | null {
  return highlightedSession(getState().mainArea);
}

/**
 * Offer to undo an archive of `sessions` that just went through.
 *
 * A pending row is left out: archiving one forgets it, and there is no
 * transcript to bring back.
 */
export function offerArchiveUndo(
  sessions: readonly SessionRow[], leavingIds: readonly string[], onScreen: string | null,
): void {
  const kept = sessions.filter(s => !pendingSessions.has(s.sessionId));
  if (!kept.length) return;
  const sessionIds = kept.map(s => s.sessionId);
  dispatch({
    type: 'archiveUndoOffered',
    undo: {
      sessionIds,
      label: archiveUndoLabel(kept.map(sessionDisplayName)),
      leavingIds,
      reopen: onScreen && sessionIds.includes(onScreen) ? onScreen : null,
    },
  });
}

/** Undo on the toast, or ⌘Z while it is up. */
export async function undoArchive(): Promise<void> {
  const { undo } = getState().archiveUndo;
  if (undo) await undoArchiveWith(steps, undo);
}

/** Put the toast away without undoing. */
export function closeArchiveUndo(id: number): void {
  dispatch({ type: 'archiveUndoClosed', id });
}

const steps: UndoSteps = {
  dispatch,
  unarchive: async (sessionId) => {
    const session = sessionMap.get(sessionId);
    if (!session) return false;
    return archiveSessionRow(session, 0);
  },
  reopen: async (sessionId) => {
    const session = sessionMap.get(sessionId);
    if (session) await openSession(session);
  },
  reload: () => loadProjects(),
  offeredSession: () => getState().sessionTask.offer?.sessionId ?? null,
};

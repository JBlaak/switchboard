/**
 * What a VM session's Bring back does (#276): Bring back from a row or the
 * session tray, the dialog's preview and run, the choice about a branch that
 * is here already, and Cancel while it waits for the turn to end. The
 * components call these, never `window.api` or the store.
 *
 * What happens to the row and the terminal once the session continues here is
 * `continueHere`, run by the IPC follow-up for the done phase.
 */
import {dispatch} from '../../state/app-store';
import {sessionMap, pendingSessions} from '../../state/session-store';
import {sessionDisplayName} from '../../state/session-list-layout';
import {openDialog} from './actions';
import {bringBackPhaseAnswer, bringBackPreviewAnswer} from './session-bring-back-view';
import type {ExistingBranchChoice} from '../../../domain/project/branch-worktree';

/** Bring back was pressed: the dialog opens, and asks the VM what would come back. */
export async function openSessionBringBack(sessionId: string): Promise<void> {
    const row = sessionMap.get(sessionId) ?? pendingSessions.get(sessionId)?.session;
    dispatch({type: 'bringBackDialogOpened', sessionId, name: row ? sessionDisplayName(row) : ''});
    openDialog({kind: 'bringBackSession', sessionId});
    const answer: unknown = await window.api
        .previewSessionBringBack(sessionId)
        .catch((err: Error) => ({error: err.message}));
    dispatch({type: 'bringBackPreviewLoaded', sessionId, answer: bringBackPreviewAnswer(answer)});
}

export function closeSessionBringBack(close: () => void): void {
    dispatch({type: 'bringBackDialogClosed'});
    close();
}

/**
 * Bring back, Retry, or one of the choices for a branch that is here already.
 * The phases arrive as main pushes them; the answer is the last one, kept in
 * case its push was lost.
 */
export async function runSessionBringBack(
    sessionId: string,
    busy: boolean,
    existing?: ExistingBranchChoice,
): Promise<void> {
    dispatch({type: 'bringBackStartedRun', sessionId, busy});
    const answer: unknown = await window.api
        .bringBackSession(sessionId, existing)
        .catch((err: Error) => ({kind: 'failed', error: err.message}));
    dispatch({type: 'bringBackFinishedRun', sessionId, phase: bringBackPhaseAnswer(answer)});
}

/** Cancel, while it waits for the turn to end; main answers with the cancelled phase. */
export async function cancelSessionBringBack(sessionId: string): Promise<void> {
    await window.api.cancelSessionBringBack(sessionId).catch(() => false);
}

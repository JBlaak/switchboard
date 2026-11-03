/**
 * What session hand-off does (#276 stage 3): Hand off to… from a row or the
 * terminal header, the dialog's preview, ticks and run, and Cancel while it
 * waits for the turn to end. The components call these, never `window.api`
 * or the store.
 *
 * A failed call is answered by main as `{ ok: false, error }` in place of
 * what was asked, so each answer is checked for its shape before it is kept.
 * What happens to the row and the terminal once the session continues on the
 * VM is `continueOnVm`, run by the IPC follow-up for the done phase.
 */
import {dispatch, getState} from '../../state/app-store';
import {sessionMap, pendingSessions} from '../../state/session-store';
import {sessionDisplayName} from '../../state/session-list-layout';
import {openDialog} from './actions';
import {phaseAnswer} from './session-handoff-view';
import type {HandoffHost} from '../../../application/services/project-handoff';
import type {SessionHandoffPreview} from '../../../application/services/session-handoff';

/** Hand off to… with a host picked: the dialog opens, and asks what would go over. */
export async function openSessionHandOff(sessionId: string, host: HandoffHost): Promise<void> {
    const row = sessionMap.get(sessionId) ?? pendingSessions.get(sessionId)?.session;
    dispatch({type: 'sessionHandoffDialogOpened', sessionId, host, name: row ? sessionDisplayName(row) : ''});
    openDialog({kind: 'handOffSession', sessionId, host});
    const answer: unknown = await window.api
        .previewSessionHandoff(sessionId)
        .catch((err: Error) => ({error: err.message}));
    dispatch({type: 'sessionHandoffPreviewLoaded', sessionId, answer: previewAnswer(answer)});
}

export function toggleSessionHandoffFile(path: string): void {
    dispatch({type: 'sessionHandoffFileToggled', path});
}

export function closeSessionHandOff(close: () => void): void {
    dispatch({type: 'sessionHandoffDialogClosed'});
    close();
}

/**
 * Hand off (or Retry): carry the ticked files along. The phases arrive as
 * main pushes them; the answer is the last one, kept in case its push was lost.
 */
export async function runSessionHandOff(
    sessionId: string,
    host: HandoffHost,
    ticked: readonly string[],
    busy: boolean,
): Promise<void> {
    const running = getState().view.activePtyIds.has(sessionId);
    dispatch({type: 'sessionHandoffStarted', sessionId, host, busy, running});
    const answer: unknown = await window.api
        .handOffSession(sessionId, host.key, [...ticked])
        .catch((err: Error) => ({kind: 'failed', error: err.message}));
    dispatch({type: 'sessionHandoffFinished', sessionId, phase: phaseAnswer(answer)});
}

/** Cancel, while it waits for the turn to end; main answers with the cancelled phase. */
export async function cancelSessionHandOff(sessionId: string): Promise<void> {
    await window.api.cancelSessionHandoff(sessionId).catch(() => false);
}

// ── Shapes ──

function previewAnswer(value: unknown): SessionHandoffPreview | {error: string} {
    if (!value || typeof value !== 'object') return {error: 'Couldn’t read the session'};
    const preview = value as Record<string, unknown>;
    if (typeof preview.error === 'string') return {error: preview.error};
    if (
        typeof preview.localPath === 'string' &&
        (preview.worktree === null || typeof preview.worktree === 'string') &&
        typeof preview.branch === 'string' &&
        typeof preview.unpushed === 'number' &&
        typeof preview.uncommitted === 'number' &&
        Array.isArray(preview.candidates) &&
        typeof preview.busy === 'boolean'
    ) {
        return value as SessionHandoffPreview;
    }
    return {error: 'Couldn’t read the session'};
}

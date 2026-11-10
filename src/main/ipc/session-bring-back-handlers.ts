/**
 * A VM session brought back to this Mac (#276), the counterpart of its
 * hand-off: the preview the dialog shows, the Bring back itself, and Cancel
 * while it waits for the turn to end.
 *
 * Every call goes to the `SessionBringBack` façade. Each phase is pushed to
 * the window as it comes, keyed by the session; the call also answers the last
 * one. On done the session runs here under the same id: the window is told it
 * started here, so the open terminal attaches to it, and the project list is
 * read again, so the row moves to the local project.
 */
import {EVENT, INVOKE} from '../../ipc/channels';
import type {SessionBringBack, SessionBringBackPhase} from '../../application/services/session-bring-back';
import type {ExistingBranchChoice} from '../../domain/project/branch-worktree';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

function bringBackOf(app: Container): SessionBringBack {
    if (!app.sessionBringBack) throw new Error('Bring back isn’t available in this build');
    return app.sessionBringBack;
}

function sessionIdOf(input: unknown): string {
    if (typeof input !== 'string' || input === '') throw new Error('No session to bring back');
    return input;
}

/** What to do with a branch that is here already, and nothing else the renderer sent. */
function existingChoice(input: unknown): ExistingBranchChoice | undefined {
    if (input === undefined || input === null) return undefined;
    if (input === 'reuse' || input === 'replace') return input;
    throw new Error('Not a choice for an existing branch');
}

export function registerSessionBringBackHandlers(ipc: IpcRegistrar, app: Container): void {
    const push = (sessionId: string, phase: SessionBringBackPhase): void => {
        const window = app.getWindow();
        if (window && !window.isDestroyed()) window.webContents.send(EVENT.sessionBringBackPhase, sessionId, phase);
    };

    ipc.handle(INVOKE.sessionBringBackPreview, (sessionId: unknown) =>
        bringBackOf(app).preview(sessionIdOf(sessionId)),
    );

    ipc.handle(
        INVOKE.sessionBringBackRun,
        async (sessionId: unknown, existing: unknown): Promise<SessionBringBackPhase> => {
            const id = sessionIdOf(sessionId);
            const choice = existingChoice(existing);
            let last: SessionBringBackPhase;
            try {
                last = await bringBackOf(app).bringBack(id, choice, (phase) => push(id, phase));
            } catch (err) {
                last = {kind: 'failed', error: (err as Error).message};
                push(id, last);
            }
            if (last.kind === 'done') {
                app.renderer.sessionStarted(id, last.projectPath);
                app.renderer.projectsChanged();
            }
            return last;
        },
    );

    ipc.handle(INVOKE.sessionBringBackCancel, (sessionId: unknown) =>
        typeof sessionId === 'string' && sessionId ? (app.sessionBringBack?.cancel(sessionId) ?? false) : false,
    );
}

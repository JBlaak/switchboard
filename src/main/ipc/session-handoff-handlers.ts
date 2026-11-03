/**
 * Session hand-off to a VM (#276 stage 3): the preview the dialog shows, the
 * hand-off itself, and Cancel while it waits for the turn to end.
 *
 * Every call goes to the `SessionHandoff` façade. Each phase is pushed to the
 * window as it comes, keyed by the session; the call also answers the last
 * one. On done the session runs on the VM under the same id: the window is
 * told it started there, so the open terminal attaches to it, and the project
 * list is read again, so the row moves to the copy.
 *
 * Until the composition root builds the façade, every call fails with a
 * message, and the dialog shows it.
 */
import {EVENT, INVOKE} from '../../ipc/channels';
import type {SessionHandoff, SessionHandoffPhase} from '../../application/services/session-handoff';
import type {Container} from '../composition-root';
import type {IpcRegistrar} from './support/registrar';

/** The façade, until the composition root builds one; a call before then fails with this. */
function sessionHandoffOf(app: Container): SessionHandoff {
    if (!app.sessionHandoff) throw new Error('Session hand-off isn’t available in this build');
    return app.sessionHandoff;
}

function sessionIdOf(input: unknown): string {
    if (typeof input !== 'string' || input === '') throw new Error('No session to hand off');
    return input;
}

/** The ticked paths, and nothing else the renderer sent. */
function tickedPaths(input: unknown): string[] {
    return Array.isArray(input) ? input.filter((path): path is string => typeof path === 'string') : [];
}

export function registerSessionHandoffHandlers(ipc: IpcRegistrar, app: Container): void {
    const push = (sessionId: string, phase: SessionHandoffPhase): void => {
        const window = app.getWindow();
        if (window && !window.isDestroyed()) window.webContents.send(EVENT.sessionHandoffPhase, sessionId, phase);
    };

    ipc.handle(INVOKE.sessionHandoffPreview, (sessionId: unknown) =>
        sessionHandoffOf(app).preview(sessionIdOf(sessionId)),
    );

    ipc.handle(
        INVOKE.sessionHandoffRun,
        async (sessionId: unknown, hostKey: unknown, ticked: unknown): Promise<SessionHandoffPhase> => {
            const id = sessionIdOf(sessionId);
            if (typeof hostKey !== 'string' || !hostKey) throw new Error('No host to hand off to');
            let last: SessionHandoffPhase;
            try {
                last = await sessionHandoffOf(app).handOff(id, hostKey, tickedPaths(ticked), (phase) =>
                    push(id, phase),
                );
            } catch (err) {
                last = {kind: 'failed', error: (err as Error).message};
                push(id, last);
            }
            if (last.kind === 'done') {
                app.renderer.sessionStarted(id, last.copyPath);
                app.renderer.projectsChanged();
            }
            return last;
        },
    );

    ipc.handle(INVOKE.sessionHandoffCancel, (sessionId: unknown) =>
        typeof sessionId === 'string' && sessionId ? (app.sessionHandoff?.cancel(sessionId) ?? false) : false,
    );
}

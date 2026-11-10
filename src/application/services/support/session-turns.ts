/**
 * Waiting on a session's turn and on its stop, as a session's hand-off to a VM
 * and its Bring back from one both need (#276): neither cuts a turn off, and
 * neither moves a conversation while its process still runs.
 */
import type {Timers} from '../../ports/clock';
import type {Disposable} from '../../ports/git-workspace';
import type {SessionPrompter} from '../../ports/session-prompter';
import {withTimeout} from '../project-handoff-service';
import {STOP_ESCALATE_MS, STOP_GIVE_UP_MS} from '../session-lifecycle';

/**
 * How long a move waits for the stopped session's process to end. The
 * lifecycle's own escalation retires the record after SIGTERM, SIGKILL and a
 * give-up, so this only catches a stop that never reached the lifecycle.
 */
export const STOP_WAIT_MS = STOP_ESCALATE_MS + STOP_GIVE_UP_MS + 2000;

/** A move in flight: `cancel` is set only while it waits for the turn to end. */
export interface InFlight {
    cancel: (() => void) | null;
}

type Prompter = Pick<SessionPrompter, 'runningId' | 'isBusy' | 'onIdle' | 'onExit'>;

/** Resolve when the session comes to its prompt or ends; or 'cancelled' when `flight.cancel` is called first. */
export function turnEnded(prompter: Prompter, sessionId: string, flight: InFlight): Promise<'idle' | 'cancelled'> {
    return new Promise((resolve) => {
        const subscriptions: Disposable[] = [];
        const settle = (how: 'idle' | 'cancelled') => {
            subscriptions.forEach((subscription) => subscription.dispose());
            flight.cancel = null;
            resolve(how);
        };
        flight.cancel = () => settle('cancelled');
        subscriptions.push(prompter.onIdle(sessionId, () => settle('idle')));
        subscriptions.push(prompter.onExit(sessionId, () => settle('idle')));
        // It may have gone idle between the caller's look and the subscription.
        if (!prompter.runningId(sessionId) || !prompter.isBusy(sessionId)) settle('idle');
    });
}

/**
 * Stop the session as the renderer's Stop does (`stop`) and wait for its
 * process to end. Rejects when it does not end within STOP_WAIT_MS; answers
 * false when the stop was refused.
 */
export async function stopAndWait(
    prompter: Prompter,
    timers: Timers,
    stop: (sessionId: string) => {ok: boolean},
    sessionId: string,
): Promise<boolean> {
    let subscription: Disposable | null = null;
    const ended = new Promise<void>((resolve) => {
        subscription = prompter.onExit(sessionId, resolve);
    });
    try {
        if (!stop(sessionId).ok) return false;
        if (prompter.runningId(sessionId)) await withTimeout(ended, STOP_WAIT_MS, timers);
        return true;
    } finally {
        (subscription as Disposable | null)?.dispose();
    }
}

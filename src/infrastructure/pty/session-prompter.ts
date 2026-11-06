/**
 * The running sessions' PTYs behind the SessionPrompter port.
 *
 * A prompt is written as a bracketed paste, with Enter a moment later; why is
 * in `domain/terminal/paste`, which the renderer's saved prompts share.
 *
 * Busy and idle are the session's own CLI state (`CliBusyTracker`, fed from
 * OSC 7501 or the title), heard through the lifecycle as the renderer hears it.
 */
import type {Timers} from '../../application/ports/clock';
import type {Disposable} from '../../application/ports/git-workspace';
import type {Logger} from '../../application/ports/logger';
import type {SessionPrompter} from '../../application/ports/session-prompter';
import type {CliStateChange} from '../../domain/terminal/osc';
import {PASTE_END, PASTE_START, SUBMIT_DELAY_MS, pasteBytes} from '../../domain/terminal/paste';

export {PASTE_END, PASTE_START, SUBMIT_DELAY_MS, pasteBytes};

/** What the prompter reads off a running session. */
export interface PromptableSession {
    readonly pty: {write(data: string): void};
    readonly exited: boolean;
    readonly isPlainTerminal: boolean;
    readonly cliBusy: {readonly busy: boolean; readonly ready: boolean};
    /** Every id the session has answered to, given the one it is keyed by now. */
    allIds(currentKey: string): string[];
}

/** The session registry, as far as the prompter needs it. */
export interface PromptableSessions {
    find(sessionId: string): {key: string; session: PromptableSession} | null;
}

export class PtySessionPrompter implements SessionPrompter {
    private readonly listeners = new Map<string, Set<() => void>>();
    private readonly exitListeners = new Map<string, Set<() => void>>();

    constructor(private readonly deps: {sessions: PromptableSessions; timers: Timers; log: Logger}) {}

    public runningId(sessionId: string): string | null {
        const found = this.find(sessionId);
        return found ? found.key : null;
    }

    public isBusy(sessionId: string): boolean {
        const found = this.find(sessionId);
        if (!found) return true;
        const {busy, ready} = found.session.cliBusy;
        return busy || !ready;
    }

    public onIdle(sessionId: string, fn: () => void): Disposable {
        return listen(this.listeners, sessionId, fn);
    }

    public onExit(sessionId: string, fn: () => void): Disposable {
        return listen(this.exitListeners, sessionId, fn);
    }

    public send(sessionId: string, prompt: string): void {
        const found = this.find(sessionId);
        if (!found) {
            this.deps.log.warn(`[session-work] not sending to ${sessionId}: it is not running`);
            return;
        }
        const {session} = found;
        const pty = session.pty;
        pty.write(pasteBytes(prompt));
        this.deps.timers.setTimeout(() => {
            // The session may have ended, or reconnected on a new PTY, in between.
            if (session.exited || session.pty !== pty) return;
            pty.write('\r');
        }, SUBMIT_DELAY_MS);
    }

    /** From the lifecycle: a session's CLI changed state. */
    public cliStateChanged(sessionId: string, session: PromptableSession, change: CliStateChange): void {
        const idle = change.kind === 'ready' || (change.kind === 'busy' && !change.busy);
        if (!idle) return;
        this.notify(this.listeners, sessionId, session, 'idle');
    }

    /** From the lifecycle: a session's process ended for good. */
    public sessionEnded(sessionId: string, session: PromptableSession): void {
        this.notify(this.exitListeners, sessionId, session, 'exit');
    }

    /** Call every listener filed under any id the session has answered to. */
    private notify(
        listeners: Map<string, Set<() => void>>,
        sessionId: string,
        session: PromptableSession,
        what: string,
    ): void {
        const fns: Array<() => void> = [];
        for (const id of session.allIds(sessionId)) {
            for (const fn of listeners.get(id) ?? []) fns.push(fn);
        }
        for (const fn of fns) {
            try {
                fn();
            } catch (err) {
                this.deps.log.error(`[session-work] an ${what} listener failed:`, (err as Error).message);
            }
        }
    }

    private find(sessionId: string): {key: string; session: PromptableSession} | null {
        const found = this.deps.sessions.find(sessionId);
        if (!found || found.session.exited || found.session.isPlainTerminal) return null;
        return found;
    }
}

function listen(listeners: Map<string, Set<() => void>>, sessionId: string, fn: () => void): Disposable {
    let set = listeners.get(sessionId);
    if (!set) {
        set = new Set();
        listeners.set(sessionId, set);
    }
    set.add(fn);
    return {
        dispose: () => {
            const current = listeners.get(sessionId);
            if (!current) return;
            current.delete(fn);
            if (current.size === 0) listeners.delete(sessionId);
        },
    };
}

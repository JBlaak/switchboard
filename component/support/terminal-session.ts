/**
 * Main's side of a running Claude session, for the component harness, where
 * there is no PTY and no process.
 *
 * `FakeSessions` answers `openTerminal`, `getActiveSessions` and `stopSession`
 * the way main's launcher and registry do, and `FakeClaude` stands in for the
 * e2e fake `claude` (e2e/support/fake-cli.ts): what it prints goes through the
 * same steps as main's `SessionLifecycle.wire` (src/application/services/
 * session-lifecycle.ts). Each chunk is parsed with main's own OSC parser and
 * busy tracker, which decide the `onCliBusyState`, `onSessionNeedsAttention`,
 * `onSessionAgents` and `onTerminalNotification` events sent ahead of it, and
 * the raw chunk follows as `onTerminalData`. Titles, OSC 8 links and OSC 52
 * are xterm's, in the renderer, so they only need the raw bytes.
 *
 * What the terminal sends back is read off `sendInput`, as the e2e fake reads
 * its stdin.
 *
 * Import `test` from here: it puts these answers in place before the renderer
 * loads, over any `test.use({answers})` for the same calls (change those with
 * `api.answer` in the test).
 */
import type {Page} from '@playwright/test';
import {sessionRow, terminalStatus} from '../../e2e/support/app';
import {CliBusyTracker, parseTerminalEvents} from '../../src/domain/terminal/osc';
import {ProgramStatusChildren} from '../../src/domain/terminal/program-status-children';
import type {ProgramStatus} from '../../e2e/support/fake-cli';
import {test as base, expect} from './test';
import type {FakeApi} from './fake-api';

/**
 * The component `test`, with main's side of the sessions in place before the
 * renderer loads (as `sessions`).
 */
export const test = base.extend<{sessions: FakeSessions}>({
    api: async ({api}, use) => {
        sessionsOf(api);
        await use(api);
    },
    sessions: async ({api}, use) => {
        await use(sessionsOf(api));
    },
});

export {expect};

const fakeSessions = new WeakMap<FakeApi, FakeSessions>();

function sessionsOf(api: FakeApi): FakeSessions {
    let sessions = fakeSessions.get(api);
    if (!sessions) fakeSessions.set(api, (sessions = new FakeSessions(api)));
    return sessions;
}

/** What one launch of a session left in main: its trackers, as a fresh `ActiveSession` has. */
interface Running {
    busy: CliBusyTracker;
    agents: ProgramStatusChildren;
}

/** The exit code the fake `claude` ends with when stopped (SIGTERM, as main's stop sends). */
const STOPPED_EXIT_CODE = 143;

export class FakeSessions {
    private readonly running = new Map<string, Running>();
    private readonly launchCounts = new Map<string, number>();
    /** The greeting each launch prints, so a test can wait for it to land. */
    private readonly greetings = new Map<string, Promise<void>>();

    constructor(private readonly api: FakeApi) {
        // What `resolveDefaultSessionOptions` reads: no project defaults.
        api.handle('getEffectiveSettings', () => ({}));
        // What the session tray asks main for as the pointer crosses the header:
        // a session with nothing to show, no IDE and no VM to hand off to.
        api.answer('getSessionLinks', []);
        api.answer('getSessionStats', {
            contextUsed: null,
            messageCount: null,
            startedAt: null,
            branch: null,
            shell: null,
        });
        api.answer('savedPrompts', {global: [], project: []});
        api.answer('workspaceEditor', {available: false, reason: 'No editor in the component harness'});
        api.answer('canOpenSessionWork', false);
        api.answer('handoffHosts', []);
        api.handle('getActiveSessions', () => [...this.running.keys()]);
        api.handle('openTerminal', (sessionId, _projectPath, isNew) => {
            // A session still running is reattached, not launched again. (Main
            // also replays its buffered output then; no test here needs that.)
            if (this.running.has(sessionId)) return {ok: true, reattached: true};
            this.running.set(sessionId, {busy: new CliBusyTracker(), agents: new ProgramStatusChildren()});
            this.launchCounts.set(sessionId, this.launches(sessionId) + 1);
            // The PTY's first output arrives after the invoke has answered.
            this.greetings.set(
                sessionId,
                new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => this.claude(sessionId).greet(isNew)),
            );
            return {ok: true, reattached: false};
        });
        api.handle('stopSession', (sessionId) => {
            if (!this.running.has(sessionId)) return {ok: true, alreadyStopped: true};
            // The kill is sent; the exit, and the retire that tells the renderer, follow.
            setTimeout(() => void this.claude(sessionId).exit(STOPPED_EXIT_CODE), 0);
            return {ok: true};
        });
    }

    /** How many times `sessionId` was launched (not reattached). */
    public launches(sessionId: string): number {
        return this.launchCounts.get(sessionId) ?? 0;
    }

    public isRunning(sessionId: string): boolean {
        return this.running.has(sessionId);
    }

    /** The session's process, to print with. */
    public claude(sessionId: string): FakeClaude {
        return new FakeClaude(this.api, sessionId, () => this.running.get(sessionId), {
            exited: () => this.running.delete(sessionId),
        });
    }

    /**
     * Main matched a new transcript to a running session (a fork, or an
     * accepted plan): the session goes by `newId` from now on, and the renderer
     * is told.
     */
    public async fork(oldId: string, newId: string): Promise<void> {
        const session = this.running.get(oldId);
        if (!session) throw new Error(`${oldId} is not running`);
        this.running.delete(oldId);
        this.running.set(newId, session);
        await this.api.emit('onSessionForked', oldId, newId);
    }

    /** Wait until `sessionId`'s latest launch has printed its greeting. */
    public async greeted(sessionId: string): Promise<void> {
        await expect.poll(() => this.greetings.has(sessionId)).toBe(true);
        await this.greetings.get(sessionId);
    }
}

export class FakeClaude {
    constructor(
        private readonly api: FakeApi,
        public readonly sessionId: string,
        private readonly running: () => Running | undefined,
        private readonly on: {exited(): void},
    ) {}

    /** Raw output. Lines end in `\r\n` on a terminal. */
    public async print(text: string): Promise<void> {
        const session = this.running();
        if (!session) throw new Error(`${this.sessionId} is not running`);
        const id = this.sessionId;
        for (const event of parseTerminalEvents(text)) {
            switch (event.kind) {
                case 'program-status':
                case 'title':
                case 'progress': {
                    if (event.kind === 'program-status') {
                        const agents = session.agents.observe(event);
                        if (agents) await this.api.emit('onSessionAgents', id, agents);
                    }
                    const change = session.busy.observe(event);
                    if (change?.kind === 'busy') await this.api.emit('onCliBusyState', id, change.busy);
                    else if (change?.kind === 'needs-attention') await this.api.emit('onSessionNeedsAttention', id);
                    break;
                }
                case 'notification':
                    await this.api.emit('onTerminalNotification', id, event.message);
                    break;
                default:
                    break;
            }
        }
        await this.api.emit('onTerminalData', id, text);
    }

    /** Print lines, each terminated with `\r\n`. */
    public println(...lines: string[]): Promise<void> {
        return this.print(lines.map((line) => line + '\r\n').join(''));
    }

    /** What the fake `claude` prints first: the idle title and a line naming the launch. */
    public async greet(isNew: boolean): Promise<void> {
        await this.print(osc(0, '✳ Claude Code'));
        await this.print(`Fake Claude · ${isNew ? 'Started' : 'Resumed'} session ${this.sessionId}\r\n`);
    }

    /** OSC 0 with a spinner frame: the legacy "turn in flight" signal. */
    public busy(text = 'Working'): Promise<void> {
        return this.print(osc(0, '⠋ ' + text));
    }

    /** OSC 0 with the `✳` glyph: the legacy "waiting for you" signal. */
    public idle(text = 'Claude Code'): Promise<void> {
        return this.print(osc(0, '✳ ' + text));
    }

    /** OSC 7501: the Program Status Protocol, which overrides titles once spoken. */
    public status(report: ProgramStatus): Promise<void> {
        return this.print(osc(7501, programStatus(report)));
    }

    /** OSC 9: an iTerm2-style notification. */
    public notify(message: string): Promise<void> {
        return this.print(osc(9, message));
    }

    /** OSC 777 `notify` — the rxvt/Ghostty form; Switchboard does not read it today. */
    public notify777(title: string, body: string): Promise<void> {
        return this.print(osc(777, `notify;${title};${body}`));
    }

    /** The process ends: main retires the session and tells the renderer. */
    public async exit(code = 0): Promise<void> {
        this.on.exited();
        await this.api.emit('onProcessExited', this.sessionId, code);
    }

    /** Everything the terminal sent the process, joined. */
    public input(): string {
        return this.api
            .callsTo('sendInput')
            .filter(([id]) => id === this.sessionId)
            .map(([, data]) => data)
            .join('');
    }

    /** Wait until `text` has been sent to the process. */
    public async waitForInput(text: string): Promise<void> {
        await expect
            .poll(() => this.input(), {message: `${this.sessionId} to receive ${JSON.stringify(text)}`})
            .toContain(text);
    }
}

/**
 * Open a session by its row label, as the e2e `openSession` does: click it,
 * wait for its launch and greeting, and for the header to say Running.
 */
export async function openSession(
    page: Page,
    sessions: FakeSessions,
    label: string,
    sessionId: string,
): Promise<FakeClaude> {
    const before = sessions.launches(sessionId);
    await sessionRow(page, label).first().click();
    await expect.poll(() => sessions.launches(sessionId), {message: `${sessionId} to launch`}).toBe(before + 1);
    await sessions.greeted(sessionId);
    await expect(terminalStatus(page)).toHaveText('Running');
    return sessions.claude(sessionId);
}

function osc(code: number, payload: string): string {
    return `\x1b]${code};${payload}\x07`;
}

/** An OSC 7501 payload, encoded as the CLI (and the e2e fake) encodes it. */
function programStatus({state, kind, id, progress, title, msg}: ProgramStatus): string {
    const pairs = [`state=${state}`];
    if (id) pairs.push(`id=${id}`);
    if (kind) pairs.push(`kind=${kind}`);
    if (progress !== undefined) pairs.push(`progress=${progress}`);
    if (title !== undefined) pairs.push(`title=${Buffer.from(title).toString('base64')}`);
    if (msg !== undefined) pairs.push(`msg=${Buffer.from(msg).toString('base64')}`);
    return pairs.join(':');
}

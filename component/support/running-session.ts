/**
 * A session "running" in the component harness: there is no process, so main's
 * side of it is played here. Opening a row answers `openTerminal` as main does
 * when the PTY starts, and `getActiveSessions` reports it as running from then
 * on, which is what the header's Running and the rows read.
 *
 * What the session types reaches main as `sendInput`; `typedInto` reads it back
 * the way the e2e fake `claude` reads its stdin.
 */
import {expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {sessionRow, terminalStatus} from '../../e2e/support/app';
import type {FakeApi} from './fake-api';

const running = new WeakMap<FakeApi, Set<string>>();

/**
 * Answer `openTerminal` and `getActiveSessions` as main would for sessions
 * that start: each opened session is running from then on.
 */
export function runSessions(api: FakeApi): Set<string> {
    let ids = running.get(api);
    if (ids) return ids;
    ids = new Set();
    running.set(api, ids);
    const live = ids;
    api.handle('getEffectiveSettings', () => ({}));
    api.handle('openTerminal', (id) => {
        live.add(id);
        return {ok: true};
    });
    api.handle('getActiveSessions', () => [...live]);
    return live;
}

/**
 * Open a session by its row label, as clicking a stopped row resumes it, and
 * wait for the header to say it is running.
 */
export async function openSession(page: Page, api: FakeApi, label: string, sessionId: string): Promise<void> {
    runSessions(api);
    await sessionRow(page, label).first().click();
    await expect.poll(() => api.callsTo('openTerminal').some(([id]) => id === sessionId)).toBe(true);
    await expect(terminalStatus(page)).toHaveText('Running');
}

/** Everything the renderer sent `sessionId`'s terminal, joined. */
export function typedInto(api: FakeApi, sessionId: string): string {
    return api
        .callsTo('sendInput')
        .filter(([id]) => id === sessionId)
        .map(([, data]) => data)
        .join('');
}

/** Wait until `text` has been sent to `sessionId`'s terminal. */
export async function waitForInput(api: FakeApi, sessionId: string, text: string): Promise<void> {
    await expect.poll(() => typedInto(api, sessionId)).toContain(text);
}

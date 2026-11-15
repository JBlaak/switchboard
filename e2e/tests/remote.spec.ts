/**
 * A remote session in the app: the fake `ssh` dialled through the login
 * shell, main's reconnect loop behind the connection card, and the card's
 * screenshots.
 *
 * What the card says and when it is up (phases, countdowns, the progress
 * bar's runs, the green beat) is unit tested in test/remote-card.test.ts and
 * test/remote-status-render.test.ts, and what each status writes into the
 * scrollback in test/remote-connection-log.test.ts. What the card shows for
 * each status main sends, and everything VM (#276, #307: VM hosts and
 * Settings → VMs, project and session hand-off, Bring back, VM project pages,
 * where schedules run, the Tasks section and files dropped on a VM terminal),
 * which runs against stubs of main's VM side, is component tested
 * (component/tests/remote.spec.ts). These tests drive main's real reconnect
 * loop through the fake ssh.
 */
import {test, expect, forEachAppearance, screenTest} from '../support/test';
import {expectScreen, openRemoteSession, sessionRow, terminalStatus} from '../support/app';
import {pushRemoteStatus} from '../support/main-process';
import {expectTerminalText, hasTerminal} from '../support/terminal';
import {LABEL, REMOTE, S} from '../fixtures/standard';
import {SEND} from '../../src/ipc/channels';
import type {ElectronApplication} from '@playwright/test';

const TARGET = `${REMOTE.user}@${REMOTE.host}:${REMOTE.dir}`;

/**
 * Count from now the times the renderer tells main it is ready, which it does
 * right after putting the window back the way the user left it.
 */
async function countRendererReady(app: ElectronApplication): Promise<() => Promise<number>> {
    const key = '__e2eRendererReady' + Math.random().toString(36).slice(2);
    await app.evaluate(
        ({ipcMain}, {key, channel}) => {
            const counts = globalThis as unknown as Record<string, number>;
            counts[key] = 0;
            ipcMain.on(channel, () => counts[key]++);
        },
        {key, channel: SEND.rendererReady},
    );
    return () => app.evaluate((_electron, key) => (globalThis as unknown as Record<string, number>)[key], key);
}

test.describe('connecting', () => {
    test("dials the host over ssh into tmux, connects on the far end's output, and is reopened by a reload", async ({
        page,
        home,
    }) => {
        /* When */
        const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);

        /* Then */
        const launch = await ssh.launched();
        expect(launch.argv).toContain(`${REMOTE.user}@${REMOTE.host}`);
        expect(launch.argv.at(-1)).toContain('tmux attach-session');
        await expect(page.getByText('Connecting', {exact: true})).toBeVisible();
        await expect(page.getByText(TARGET, {exact: true})).toBeVisible();
        await expect(terminalStatus(page)).toHaveText('Connecting…');
        // A connecting card offers only Stop trying.
        await expect(page.getByRole('button', {name: 'Stop trying'})).toBeVisible();
        await expect(page.getByRole('button', {name: 'Retry now'})).toBeHidden();

        /* When */
        await ssh.println('joris@buildbox:~/apps/api$ ');

        /* Then */
        await expect(page.getByText('Connecting', {exact: true})).toBeHidden();
        await expect(terminalStatus(page)).toHaveText('Running');

        /* When */
        await page.reload();

        /* Then */
        await expect(terminalStatus(page)).toHaveText('Running');
        await expect.poll(() => hasTerminal(page, S.remoteApi)).toBe(true);
        expect(ssh.launches()).toHaveLength(1);
    });

    test('a rejected key gives up instead of retrying, says so in the scrollback, and Retry now opens the session again', async ({
        page,
        home,
    }) => {
        /* Given */
        const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);

        /* When */
        await ssh.println('joris@buildbox.local: Permission denied (publickey).');
        await ssh.exit(255);

        /* Then */
        await expect(page.getByText('Could not connect', {exact: true})).toBeVisible();
        await expect(page.getByText('the host rejected the connection', {exact: true})).toBeVisible();
        await expectTerminalText(page, S.remoteApi, `gave up connecting to ${TARGET}`);

        /* When */
        await page.getByRole('button', {name: 'Retry now'}).click();

        /* Then */
        await ssh.waitForLaunchCount(2);
        await expect(page.getByText('Connecting', {exact: true})).toBeVisible();
    });

    test('a dropped link is logged as a lost connection, and a reconnect dials again', async ({page, home}) => {
        /* Given */
        const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
        await ssh.println('connected');

        /* When */
        await ssh.exit(255);

        /* Then */
        await expectTerminalText(page, S.remoteApi, 'connection lost: ');
        // The first retry waits a second, then a new ssh is spawned.
        await ssh.waitForLaunchCount(2);
        await expect(page.getByText('Reconnecting', {exact: true})).toBeVisible();
    });
});

test.describe('buttons', () => {
    test('Stop trying stops the session without asking, and after a reload it waits for a click', async ({
        page,
        home,
        app,
    }) => {
        /* Given */
        const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
        await expect(page.getByText('Connecting', {exact: true})).toBeVisible();

        /* When */
        await page.getByRole('button', {name: 'Stop trying'}).click();

        /* Then */
        await expect(terminalStatus(page)).toHaveText('Stopped');
        await expect(page.getByRole('dialog')).toHaveCount(0);

        /* When */
        const ready = await countRendererReady(app);
        await page.reload();
        await expect(sessionRow(page, LABEL.remoteApi)).toBeVisible();
        // The window is restored right before the renderer tells main it is ready.
        await expect.poll(ready).toBe(1);

        /* Then */
        expect(await hasTerminal(page, S.remoteApi)).toBe(false);
        expect(ssh.launches()).toHaveLength(1);

        /* When */
        await sessionRow(page, LABEL.remoteApi).click();

        /* Then */
        await ssh.waitForLaunchCount(2);
    });
});

forEachAppearance(() => {
    // What each phase says and offers is component tested (component/tests/remote.spec.ts).
    screenTest('remote card, connecting, then retrying, then failed', async ({page, home, app}) => {
        /* When */
        await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
        await expect(page.getByText('Connecting', {exact: true})).toBeVisible();

        /* Then */
        await expectScreen(page, 'remote-connecting');

        /* When */
        await pushRemoteStatus(app, S.remoteApi, {
            phase: 'retrying',
            target: TARGET,
            reason: 'ssh connection failed or dropped',
            attempt: 2,
            maxAttempts: 6,
            delayMs: 30_000,
            everConnected: true,
        });
        await expect(terminalStatus(page)).toHaveText('Reconnecting in 30s');

        /* Then */
        await expectScreen(page, 'remote-retrying');

        /* When */
        await pushRemoteStatus(app, S.remoteApi, {
            phase: 'failed',
            target: TARGET,
            reason: 'the host rejected the connection',
            attempts: 1,
        });
        await expect(page.getByText('Could not connect', {exact: true})).toBeVisible();

        /* Then */
        await expectScreen(page, 'remote-failed');
    });
});

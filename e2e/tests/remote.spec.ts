/**
 * A remote session: the fake `ssh` dialled through the login shell, and the
 * connection card that narrates it.
 *
 * What the card says and when it is up (phases, countdowns, the progress
 * bar's runs, the green beat) is unit tested in test/remote-card.test.ts and
 * test/remote-status-render.test.ts, and what each status writes into the
 * scrollback in test/remote-connection-log.test.ts; these tests drive main's
 * real reconnect loop through the fake ssh.
 *
 * VM hosts (#276): a remote whose host has a Switchboard agent is badged VM,
 * an agentless one's page offers Install agent, and a VM's page and settings
 * show its setup checks and host settings. The agent channels answer from the
 * `agent` stub, so nothing here dials a host. What the parts say is unit
 * tested in test/agent-host-view.test.ts and the slice behind them in
 * test/agent-host-slice.test.ts.
 */
import {test, expect, forEachAppearance} from '../support/test';
import {dialog, expectScreen, openRemoteSession, sessionRow, terminalStatus} from '../support/app';
import {
    agentRequests,
    pushRemoteStatus,
    reconnectRequests,
    setHostStub,
    STUB_AGENT,
    stubReconnectRemote,
} from '../support/main-process';
import {expectTerminalText, hasTerminal} from '../support/terminal';
import {LABEL, REMOTE, REMOTE_LABEL, S, VM_REMOTE, vmFixture} from '../fixtures/standard';
import type {Locator, Page} from '@playwright/test';

const TARGET = `${REMOTE.user}@${REMOTE.host}:${REMOTE.dir}`;
const SSH_PATH = `ssh://${REMOTE.user}@${REMOTE.host}/${REMOTE.dir}`;
const VM_PATH = `ssh://${VM_REMOTE.user}@${VM_REMOTE.host}/${VM_REMOTE.dir}`;

function projectsModal(page: Page): Locator {
    return dialog(page, 'Projects');
}

/** A remote's name in the Projects modal, which its badge follows. */
function nameIn(label: string): RegExp {
    return new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** A remote's name in the Projects modal, with its badge inside it. */
function pickerName(page: Page, label: string): Locator {
    return projectsModal(page).getByText(nameIn(label));
}

async function openProjects(page: Page): Promise<void> {
    await page.getByRole('button', {name: 'Projects', exact: true}).click();
    await expect(projectsModal(page)).toBeVisible();
}

function projectPage(page: Page, label: string): Locator {
    return page.getByRole('region', {name: 'Project ' + label});
}

/** A project's page, through the Projects modal: filtered to it, then →. */
async function openProjectPage(page: Page, label: string): Promise<void> {
    await openProjects(page);
    await projectsModal(page).getByLabel('Filter projects').fill(label);
    await page.keyboard.press('ArrowRight');
    await expect(projectPage(page, label)).toBeVisible();
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
    test('Retry now asks main to reconnect', async ({page, home, app}) => {
        /* Given */
        const ssh = await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);
        await stubReconnectRemote(app, {ok: true});
        await pushRemoteStatus(app, S.remoteApi, {
            phase: 'retrying',
            target: TARGET,
            reason: 'ssh connection failed or dropped',
            delayMs: 30_000,
            everConnected: true,
        });

        /* When */
        await page.getByRole('button', {name: 'Retry now'}).click();

        /* Then */
        await expect.poll(() => reconnectRequests(app)).toEqual([S.remoteApi]);
        expect(ssh.launches()).toHaveLength(1);
    });

    test('Stop trying stops the session without asking, and after a reload it waits for a click', async ({
        page,
        home,
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
        await page.reload();
        await expect(sessionRow(page, LABEL.remoteApi)).toBeVisible();
        // Restoring runs once the list has loaded; give it time to do the wrong thing.
        await page.waitForTimeout(1_000);

        /* Then */
        expect(await hasTerminal(page, S.remoteApi)).toBe(false);
        expect(ssh.launches()).toHaveLength(1);

        /* When */
        await sessionRow(page, LABEL.remoteApi).click();

        /* Then */
        await ssh.waitForLaunchCount(2);
    });
});

test.describe('VM hosts', () => {
    test.use({fixture: vmFixture()});

    test('a host with an agent is badged VM in the Projects modal and on its page, and an agentless one keeps SSH', async ({
        page,
    }) => {
        /* When */
        await openProjects(page);

        /* Then */
        await expect(pickerName(page, REMOTE_LABEL.vm).getByText('VM', {exact: true})).toBeVisible();
        await expect(pickerName(page, REMOTE_LABEL.vm).getByText('SSH', {exact: true})).toHaveCount(0);
        await expect(pickerName(page, REMOTE_LABEL.ssh).getByText('SSH', {exact: true})).toBeVisible();
        await expect(pickerName(page, REMOTE_LABEL.ssh).getByText('VM', {exact: true})).toHaveCount(0);

        /* When */
        await projectsModal(page).getByLabel('Filter projects').fill(REMOTE_LABEL.vm);
        await page.keyboard.press('ArrowRight');

        /* Then */
        const vm = projectPage(page, REMOTE_LABEL.vm);
        await expect(vm.getByRole('heading', {level: 1})).toHaveText(REMOTE_LABEL.vm);
        await expect(vm.getByText('VM', {exact: true})).toHaveAttribute(
            'title',
            `Runs on a Switchboard agent on ${VM_REMOTE.user}@${VM_REMOTE.host}`,
        );
        await expect(vm.getByRole('region', {name: 'Setup'})).toBeVisible();
        await expect(vm.getByRole('button', {name: 'Install agent'})).toHaveCount(0);

        /* When */
        await page.keyboard.press('Escape');
        await openProjectPage(page, REMOTE_LABEL.ssh);

        /* Then */
        const ssh = projectPage(page, REMOTE_LABEL.ssh);
        await expect(ssh.getByText('VM', {exact: true})).toHaveCount(0);
        await expect(ssh.getByRole('button', {name: 'Install agent'})).toBeVisible();
        await expect(ssh.getByRole('region', {name: 'Setup'})).toHaveCount(0);
    });

    test('Install agent streams its progress lines, then the page turns into a VM page', async ({page, app}) => {
        /* Given */
        await setHostStub(app, 'agent', {
            ...STUB_AGENT,
            installLines: ['Checking the host…', 'Copying the agent (0.0.0-e2e)…', 'Starting the service…'],
            installLineDelayMs: 150,
        });
        await openProjectPage(page, REMOTE_LABEL.ssh);
        const ssh = projectPage(page, REMOTE_LABEL.ssh);

        /* When */
        await ssh.getByRole('button', {name: 'Install agent'}).click();

        /* Then */
        await expect(ssh.getByRole('button', {name: 'Installing…'})).toBeDisabled();
        await expect(ssh.getByRole('region', {name: 'Switchboard agent'})).toContainText('Checking the host…');
        const setup = ssh.getByRole('region', {name: 'Setup'});
        await expect(setup).toBeVisible();
        for (const line of ['Checking the host…', 'Copying the agent (0.0.0-e2e)…', 'Starting the service…']) {
            await expect(setup).toContainText(line);
        }
        await expect(setup.getByText('Ready', {exact: true})).toBeVisible();
        await expect(ssh.getByRole('region', {name: 'Switchboard agent'})).toHaveCount(0);
        await expect(ssh.getByText('VM', {exact: true})).toBeVisible();
        expect((await agentRequests(app)).install).toEqual([SSH_PATH]);
    });

    test('a failed install shows why and offers Retry, which installs again', async ({page, app}) => {
        /* Given */
        await setHostStub(app, 'agent', {
            ...STUB_AGENT,
            installLines: ['Checking the host…'],
            installResult: {ok: false, error: 'The host isn’t Linux (it runs Darwin)'},
        });
        await openProjectPage(page, REMOTE_LABEL.ssh);
        const card = projectPage(page, REMOTE_LABEL.ssh).getByRole('region', {name: 'Switchboard agent'});

        /* When */
        await card.getByRole('button', {name: 'Install agent'}).click();

        /* Then */
        await expect(card.getByRole('alert')).toHaveText('The host isn’t Linux (it runs Darwin)');
        await expect(card).toContainText('Checking the host…');
        await expect(card.getByRole('button', {name: 'Retry'})).toBeEnabled();

        /* When */
        await setHostStub(app, 'agent', {...STUB_AGENT, installLines: ['Starting the service…']});
        await card.getByRole('button', {name: 'Retry'}).click();

        /* Then */
        await expect(projectPage(page, REMOTE_LABEL.ssh).getByRole('region', {name: 'Setup'})).toBeVisible();
        expect((await agentRequests(app)).install).toEqual([SSH_PATH, SSH_PATH]);
    });

    test('a VM’s page shows its tool checks, and its settings show the host settings and save a change', async ({
        page,
        app,
    }) => {
        /* Given */
        await setHostStub(app, 'agent', {
            ...STUB_AGENT,
            tools: {
                tools: [
                    {tool: 'claude', installed: true, version: '2.1.0', loggedIn: true},
                    {tool: 'gh', installed: true, version: '2.60.1', loggedIn: false},
                ],
                sudo: false,
            },
        });

        /* When */
        await openProjectPage(page, REMOTE_LABEL.vm);

        /* Then */
        const setup = projectPage(page, REMOTE_LABEL.vm).getByRole('region', {name: 'Setup'});
        await expect(setup.getByText('Installed, 2.1.0 · signed in', {exact: true})).toBeVisible();
        await expect(setup.getByText('Installed, 2.60.1 · not signed in', {exact: true})).toBeVisible();
        await expect(setup.getByText('Not installed', {exact: true})).toBeVisible();
        await expect(setup.getByText('Ready', {exact: true})).toHaveCount(0);

        /* When */
        await setup.getByRole('button', {name: 'Open setup terminal'}).click();

        /* Then */
        await expect(setup.getByRole('alert')).toHaveText('No setup terminal in the harness');
        expect((await agentRequests(app)).openSetupTerminal).toEqual([VM_PATH]);

        /* When */
        await projectPage(page, REMOTE_LABEL.vm).getByRole('button', {name: 'Settings', exact: true}).click();

        /* Then */
        const thisVm = page
            .getByRole('region', {name: 'Settings for ' + REMOTE_LABEL.vm})
            .getByRole('region', {name: 'This VM'});
        await expect(thisVm.getByLabel('Host instructions')).toHaveValue(STUB_AGENT.hostSettings!.instructions);
        await expect(thisVm.getByRole('switch', {name: 'Copy my Claude config to this VM'})).toHaveAttribute(
            'aria-checked',
            'false',
        );
        await expect(thisVm.getByLabel('Base folder for copies')).toHaveValue('~/projects');

        /* When */
        await thisVm.getByLabel('Base folder for copies').fill('~/work');
        await thisVm.getByLabel('Base folder for copies').press('Enter');

        /* Then */
        await expect
            .poll(async () => (await agentRequests(app)).setHostSettings)
            .toEqual([{projectPath: VM_PATH, change: {baseFolder: '~/work'}}]);
        await expect(thisVm.getByLabel('Base folder for copies')).toHaveValue('~/work');

        /* When */
        await thisVm.getByRole('switch', {name: 'Copy my Claude config to this VM'}).click();

        /* Then */
        await expect(thisVm.getByRole('switch', {name: 'Copy my Claude config to this VM'})).toHaveAttribute(
            'aria-checked',
            'true',
        );
        await expect
            .poll(async () => (await agentRequests(app)).setHostSettings)
            .toEqual([
                {projectPath: VM_PATH, change: {baseFolder: '~/work'}},
                {projectPath: VM_PATH, change: {copyConfig: true}},
            ]);
    });
});

forEachAppearance(() => {
    test('remote card, connecting', async ({page, home}) => {
        /* When */
        await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);

        /* Then */
        await expect(page.getByText('Connecting', {exact: true})).toBeVisible();
        await expectScreen(page, 'remote-connecting');
    });

    test('remote card, retrying', async ({page, home, app}) => {
        /* Given */
        await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);

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

        /* Then */
        // Said twice: on the card, and as the header's status.
        await expect(page.getByText('Reconnecting in 30s', {exact: true})).toHaveCount(2);
        await expect(terminalStatus(page)).toHaveText('Reconnecting in 30s');
        await expectScreen(page, 'remote-retrying');
    });

    test('remote card, failed', async ({page, home, app}) => {
        /* Given */
        await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);

        /* When */
        await pushRemoteStatus(app, S.remoteApi, {
            phase: 'failed',
            target: TARGET,
            reason: 'the host rejected the connection',
            attempts: 1,
        });

        /* Then */
        await expect(page.getByText('Could not connect', {exact: true})).toBeVisible();
        await expectScreen(page, 'remote-failed');
    });
});

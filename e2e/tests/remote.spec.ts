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
 *
 * Project hand-off (#276 stage 2): Hand off to… on a local project's page,
 * the copies it lists under On VMs and the copy's link back, and a copy's
 * Bring back and Remove copy. The `handoff:*` channels answer from the
 * `handoff` stub, so nothing here runs ssh or git against a VM. What the parts
 * say is unit tested in test/handoff-view.test.ts and the slice behind them in
 * test/handoff-slice.test.ts.
 *
 * Session hand-off (#276 stage 3): Hand off to… on a local Claude session's
 * row and in the terminal header, the dialog in session mode, the wait for
 * the turn to end with Cancel, the row's marker while it runs, and a failure.
 * The `session-handoff:*` channels answer from the `sessionHandoff` stub, so
 * nothing here waits on a real turn or runs ssh or git. What the parts say is
 * unit tested in test/session-handoff-view.test.ts and the slice behind them.
 *
 * VM transcripts (#276 stage 3): a VM session's row takes its title from the
 * `vm_transcripts` cache, seeded by `vmTranscriptFixture`.
 *
 * VM project pages (#276 stage 4): a VM project's page shows the GitHub
 * sections, plans and worktrees from a stubbed `projectOverview`, and its
 * GitHub button and ⌘-click ask to open the repository; a VM Claude session's
 * meta line opens Session work from the `sessionWork` stub, while a VM shell
 * and an agentless remote's rows say why not. Nothing here reads git or `gh`
 * on a VM. Which parts show is unit tested in test/project-page-vm.test.ts and
 * test/session-list-work-trigger.test.ts.
 */
import {test, expect, forEachAppearance} from '../support/test';
import {
    dialog,
    expectScreen,
    openRemoteSession,
    openSession,
    sessionRow,
    sidebar,
    terminalHeader,
    terminalStatus,
} from '../support/app';
import {
    agentRequests,
    handoffRequests,
    openedExternally,
    pushRemoteStatus,
    reconnectRequests,
    sessionHandoffRequests,
    setHostStub,
    STUB_AGENT,
    STUB_HANDOFF,
    STUB_HANDOFF_HOST,
    STUB_SESSION_HANDOFF,
    STUB_SESSION_PREVIEW,
    stubOpenTerminal,
    stubReconnectRemote,
    terminalsOpened,
} from '../support/main-process';
import {redraw, sessionItem} from '../support/session-list';
import {answerDialogs, dialogsAsked} from '../support/native-dialogs';
import {expectTerminalText, hasTerminal} from '../support/terminal';
import {
    COPY_REMOTE,
    handoffFixture,
    LABEL,
    P,
    REMOTE,
    REMOTE_LABEL,
    S,
    VM_REMOTE,
    vmFixture,
    vmTranscriptFixture,
} from '../fixtures/standard';
import {acmeOverview} from '../fixtures/plans';
import {LOGIN_FIX_WORK} from '../fixtures/session-work';
import {hoursAgo, sessionId} from '../support/fixture-home';
import {REMOTE_REASON, VM_SHELL_REASON} from '../../src/renderer/ui/session-list/work-trigger';
import {REMOTE_NOTE} from '../../src/renderer/ui/project-page/page-state';
import type {FixtureHome, FixtureSpec} from '../support/fixture-home';
import type {HandoffStub, SessionWorkStub} from '../support/main-process';
import type {ProjectOverview} from '../../src/domain/project/overview';
import type {Locator, Page} from '@playwright/test';

const TARGET = `${REMOTE.user}@${REMOTE.host}:${REMOTE.dir}`;
const SSH_PATH = `ssh://${REMOTE.user}@${REMOTE.host}/${REMOTE.dir}`;
const VM_PATH = `ssh://${VM_REMOTE.user}@${VM_REMOTE.host}/${VM_REMOTE.dir}`;
const COPY_PATH = `ssh://${COPY_REMOTE.user}@${COPY_REMOTE.host}/${COPY_REMOTE.dir}`;

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

test.describe('project hand-off', () => {
    test.use({fixture: handoffFixture(), stubs: {handoff: STUB_HANDOFF}});

    function handOffDialog(page: Page): Locator {
        return page.getByRole('dialog', {name: 'Hand off to ' + STUB_HANDOFF_HOST.label});
    }

    function thisCopy(page: Page): Locator {
        return projectPage(page, REMOTE_LABEL.copy).getByRole('region', {name: 'This copy'});
    }

    /** The hand-off stub, with acme-api's copy linked both ways. */
    function linkedCopy(home: FixtureHome, change: Partial<HandoffStub> = {}): HandoffStub {
        const local = home.projectPath(P.acmeApi);
        return {
            ...STUB_HANDOFF,
            copies: {
                [local]: [{copyPath: COPY_PATH, hostKey: STUB_HANDOFF_HOST.key, hostLabel: STUB_HANDOFF_HOST.label}],
            },
            origins: {[COPY_PATH]: local},
            ...change,
        };
    }

    test('Hand off to… shows what goes over and the ignored files, hands off the ticked ones with its progress, and opens the copy', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        const lines = ['Bundling 2 commits…', 'Cloning on joris@devbox.local…', 'Copying 1 file…'];
        await setHostStub(app, 'handoff', {...STUB_HANDOFF, lines, lineDelayMs: 150});
        await openProjectPage(page, P.acmeApi);

        /* When */
        await projectPage(page, P.acmeApi).getByRole('button', {name: 'Hand off to…'}).click();

        /* Then */
        const dialog = handOffDialog(page);
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('listitem')).toHaveText([
            'Branch main',
            '2 commits not on origin',
            '1 uncommitted change',
        ]);
        const env = dialog.getByRole('checkbox', {name: '.env 312 B', exact: true});
        const envLocal = dialog.getByRole('checkbox', {name: '.env.local 4.1 KB', exact: true});
        await expect(env).toBeChecked();
        await expect(envLocal).not.toBeChecked();
        await expect(dialog).toContainText('Ticked files are copied to the VM as they are.');

        /* When */
        await env.uncheck();
        await envLocal.check();
        await dialog.getByRole('button', {name: 'Hand off', exact: true}).click();

        /* Then */
        await expect(dialog.getByRole('button', {name: 'Handing off…'})).toBeDisabled();
        await expect(envLocal).toBeDisabled();
        for (const line of lines) await expect(dialog).toContainText(line);
        await expect(dialog.getByRole('status')).toHaveText('Handed off');
        await expect(dialog.getByRole('button', {name: 'Close', exact: true})).toBeVisible();
        expect((await handoffRequests(app)).handOff).toEqual([
            {localPath: home.projectPath(P.acmeApi), hostKey: STUB_HANDOFF_HOST.key, ticked: ['.env.local']},
        ]);

        /* When */
        await dialog.getByRole('button', {name: 'Open the copy'}).click();

        /* Then */
        await expect(dialog).toHaveCount(0);
        await expect(projectPage(page, REMOTE_LABEL.copy)).toBeVisible();
    });

    test('a failed hand-off shows why and offers Retry, which hands off again', async ({page, app}) => {
        /* Given */
        await setHostStub(app, 'handoff', {
            ...STUB_HANDOFF,
            lines: ['Bundling 2 commits…'],
            result: {ok: false, error: 'Couldn’t reach joris@devbox.local'},
        });
        await openProjectPage(page, P.acmeApi);
        await projectPage(page, P.acmeApi).getByRole('button', {name: 'Hand off to…'}).click();
        const dialog = handOffDialog(page);

        /* When */
        await dialog.getByRole('button', {name: 'Hand off', exact: true}).click();

        /* Then */
        await expect(dialog.getByRole('alert')).toHaveText('Couldn’t reach joris@devbox.local');
        await expect(dialog).toContainText('Bundling 2 commits…');
        await expect(dialog.getByRole('button', {name: 'Retry'})).toBeEnabled();

        /* When */
        await setHostStub(app, 'handoff', STUB_HANDOFF);
        await dialog.getByRole('button', {name: 'Retry'}).click();

        /* Then */
        await expect(dialog.getByRole('status')).toHaveText('Handed off');
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        expect((await handoffRequests(app)).handOff).toHaveLength(2);
    });

    test('a local project lists its copy under On VMs, and the copy’s page links back with Copy of …', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        await setHostStub(app, 'handoff', linkedCopy(home));

        /* When */
        await openProjectPage(page, P.acmeApi);

        /* Then */
        const onVms = projectPage(page, P.acmeApi).getByRole('region', {name: 'On VMs'});
        const copy = onVms.getByRole('button', {name: new RegExp('^' + REMOTE_LABEL.copy)});
        await expect(copy).toContainText(STUB_HANDOFF_HOST.label);
        await expect(copy.getByText('VM', {exact: true})).toBeVisible();

        /* When */
        await copy.click();

        /* Then */
        const back = projectPage(page, REMOTE_LABEL.copy).getByRole('button', {name: 'Copy of ' + P.acmeApi});
        await expect(back).toBeVisible();
        await expect(thisCopy(page).getByRole('button', {name: 'Bring back'})).toBeVisible();

        /* When */
        await back.click();

        /* Then */
        await expect(projectPage(page, P.acmeApi)).toBeVisible();
    });

    test('Bring back on a copy’s page streams its progress, then names the branch in the new worktree', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        const lines = ['Fetching from the copy…', 'Adding a worktree for from-vm…'];
        await setHostStub(app, 'handoff', linkedCopy(home, {bringBackLines: lines, lineDelayMs: 150}));
        await openProjectPage(page, REMOTE_LABEL.copy);

        /* When */
        await thisCopy(page).getByRole('button', {name: 'Bring back'}).click();

        /* Then */
        await expect(thisCopy(page).getByRole('button', {name: 'Bringing back…'})).toBeDisabled();
        await expect(thisCopy(page).getByRole('button', {name: 'Remove copy'})).toBeDisabled();
        for (const line of lines) await expect(thisCopy(page)).toContainText(line);
        await expect(thisCopy(page).getByRole('status')).toHaveText(
            'Checked out from-vm in a new worktree. Open the local project',
        );
        await expect(thisCopy(page).getByRole('button', {name: 'Open the local project'})).toBeVisible();
        expect((await handoffRequests(app)).bringBack).toEqual([COPY_PATH]);
    });

    test('Remove copy on a copy with work only it has lists the work, offers Bring back first, and Remove anyway removes it', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        await setHostStub(
            app,
            'handoff',
            linkedCopy(home, {
                copyStatus: {
                    branch: 'main',
                    unpushed: [{oid: 'abc1234', subject: 'Fix the flaky login test'}],
                    uncommitted: ['src/login.ts'],
                },
            }),
        );
        await openProjectPage(page, REMOTE_LABEL.copy);
        await answerDialogs(page, true);

        /* When */
        await thisCopy(page).getByRole('button', {name: 'Remove copy'}).click();

        /* Then */
        const work = thisCopy(page).getByRole('alert');
        await expect(work).toContainText('This copy has work that isn’t anywhere else.');
        await expect(work).toContainText('1 commit not on origin');
        await expect(work).toContainText('Fix the flaky login test');
        await expect(work).toContainText('1 uncommitted change');
        await expect(work).toContainText('src/login.ts');
        await expect(work.getByRole('button', {name: 'Bring back first'})).toBeVisible();
        expect(await dialogsAsked(page)).toEqual([]);
        expect((await handoffRequests(app)).removeCopy).toEqual([]);

        /* When */
        await work.getByRole('button', {name: 'Remove anyway'}).click();

        /* Then */
        await expect(projectPage(page, P.acmeApi)).toBeVisible();
        expect((await handoffRequests(app)).removeCopy).toEqual([COPY_PATH]);
        expect(await dialogsAsked(page)).toEqual([]);
    });

    test('Remove copy on a clean copy asks to confirm, and removes it only once confirmed', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        await setHostStub(app, 'handoff', linkedCopy(home));
        await openProjectPage(page, REMOTE_LABEL.copy);
        await answerDialogs(page, false);

        /* When */
        await thisCopy(page).getByRole('button', {name: 'Remove copy'}).click();

        /* Then */
        await expect
            .poll(() => dialogsAsked(page))
            .toEqual([
                `Remove the copy ${REMOTE_LABEL.copy}?\n\nIts folder on the VM is deleted. The local project stays as it is.`,
            ]);
        await expect(thisCopy(page).getByRole('button', {name: 'Remove copy'})).toBeEnabled();
        expect((await handoffRequests(app)).removeCopy).toEqual([]);

        /* When */
        await answerDialogs(page, true);
        await thisCopy(page).getByRole('button', {name: 'Remove copy'}).click();

        /* Then */
        await expect(projectPage(page, P.acmeApi)).toBeVisible();
        expect((await handoffRequests(app)).removeCopy).toEqual([COPY_PATH]);
    });

    test('Remove copy when the VM can’t be reached says so and removes nothing', async ({page, app, home}) => {
        /* Given */
        await setHostStub(app, 'handoff', linkedCopy(home, {copyStatus: null}));
        await openProjectPage(page, REMOTE_LABEL.copy);
        await answerDialogs(page, true);

        /* When */
        await thisCopy(page).getByRole('button', {name: 'Remove copy'}).click();

        /* Then */
        await expect(thisCopy(page).getByRole('alert')).toHaveText(
            'Couldn’t reach the VM, so the copy wasn’t removed.',
        );
        expect(await dialogsAsked(page)).toEqual([]);
        expect((await handoffRequests(app)).copyStatus).toEqual([COPY_PATH]);
        expect((await handoffRequests(app)).removeCopy).toEqual([]);
        await expect(projectPage(page, REMOTE_LABEL.copy)).toBeVisible();
    });
});

test.describe('session hand-off', () => {
    test.use({fixture: handoffFixture(), stubs: {handoff: STUB_HANDOFF}});

    function handOffDialog(page: Page): Locator {
        return page.getByRole('dialog', {name: 'Hand off to ' + STUB_HANDOFF_HOST.label});
    }

    /** Hand off to… on a row; the row's buttons show while the pointer is over it. */
    async function handOffButton(page: Page, sessionId: string): Promise<Locator> {
        const row = sessionItem(page, sessionId);
        await row.hover();
        return row.getByRole('button', {name: 'Hand off to…', exact: true});
    }

    /** A plain terminal, started as main starts one, in a project. */
    async function startPlainTerminal(page: Page, projectPath: string): Promise<string> {
        return await page.evaluate(async (projectPath) => {
            const id = crypto.randomUUID();
            await window.api.openTerminal(id, projectPath, true, {type: 'terminal'});
            return id;
        }, projectPath);
    }

    test('Hand off to… is on a local Claude session’s row and in its terminal header, never on a remote or terminal row', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        const terminal = await startPlainTerminal(page, home.projectPath(P.notes));
        await redraw(page, app, S.bumpDeps);
        await expect(sessionItem(page, terminal)).toBeVisible();

        /* Then */
        await expect(await handOffButton(page, S.loginFix)).toBeVisible();
        await expect(await handOffButton(page, S.remoteApi)).toHaveCount(0);
        await expect(await handOffButton(page, terminal)).toHaveCount(0);

        /* When */
        await openSession(page, home, LABEL.loginFix, S.loginFix);
        await terminalHeader(page).getByRole('button', {name: 'Hand off to…', exact: true}).click();

        /* Then */
        const dialog = handOffDialog(page);
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(LABEL.loginFix);
    });

    test.describe('without a VM host', () => {
        test.use({stubs: {}});

        test('no row and no terminal header offers Hand off to…', async ({page, home}) => {
            /* When */
            await openSession(page, home, LABEL.loginFix, S.loginFix);
            await sessionItem(page, S.loginFix).hover();

            /* Then */
            await expect(sessionItem(page, S.loginFix).getByRole('button', {name: 'Stop session'})).toBeVisible();
            await expect(page.getByRole('button', {name: 'Hand off to…', includeHidden: true})).toHaveCount(0);
        });
    });

    test('a busy session waits for its turn with Cancel, shows Waiting… and Handing off… on its row, then continues on the VM', async ({
        page,
        app,
    }) => {
        /* Given */
        await setHostStub(app, 'sessionHandoff', {...STUB_SESSION_HANDOFF, phaseDelayMs: 700, waitingMs: 1500});
        await (await handOffButton(page, S.loginFix)).click();
        const dialog = handOffDialog(page);

        /* Then */
        await expect(dialog.getByRole('listitem')).toHaveText([
            'The conversation, resumed on the VM',
            'Branch session-cookie',
            'In worktree session-cookie',
            '2 commits not on origin',
            '1 uncommitted change',
        ]);
        await expect(dialog).toContainText('Claude is mid-turn. The hand-off starts when this turn ends.');

        /* When */
        await dialog.getByRole('checkbox', {name: '.env.local 4.1 KB', exact: true}).check();
        await dialog.getByRole('button', {name: 'Hand off', exact: true}).click();

        /* Then */
        await expect(dialog.getByRole('status')).toHaveText('Waiting for the turn to end…');
        await expect(dialog.getByRole('button', {name: 'Cancel', exact: true})).toBeEnabled();
        await expect(dialog.getByRole('button', {name: 'Waiting…'})).toBeDisabled();
        await expect(dialog).not.toContainText('Claude is mid-turn.');
        expect((await sessionHandoffRequests(app)).handOff).toEqual([
            {sessionId: S.loginFix, hostKey: STUB_HANDOFF_HOST.key, ticked: ['.env', '.env.local']},
        ]);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(dialog).toHaveCount(0);
        const marker = sessionItem(page, S.loginFix).getByText('Waiting…', {exact: true});
        await expect(marker).toHaveAttribute('title', `Hands off to ${STUB_HANDOFF_HOST.label} when this turn ends`);
        await expect(sessionItem(page, S.loginFix).getByText('Handing off…', {exact: true})).toBeVisible();

        /* When */
        await (await handOffButton(page, S.loginFix)).click();

        /* Then */
        await expect(dialog).toContainText('Handing off the checkout…');
        await expect(dialog).toContainText('Copying the transcript…');
        await expect(dialog.getByRole('status')).toHaveText('Continues on ' + STUB_HANDOFF_HOST.label);
        await expect(dialog.getByRole('button', {name: 'Close', exact: true})).toBeVisible();
        await expect(sessionItem(page, S.loginFix).getByText(/^(Waiting|Handing off)…$/)).toHaveCount(0);
        expect((await sessionHandoffRequests(app)).handOff).toHaveLength(1);
    });

    test('Cancel while it waits for the turn closes the dialog, and nothing more is asked', async ({page, app}) => {
        /* Given */
        await setHostStub(app, 'sessionHandoff', {...STUB_SESSION_HANDOFF, waitingMs: 60_000});
        await (await handOffButton(page, S.loginFix)).click();
        const dialog = handOffDialog(page);
        await dialog.getByRole('button', {name: 'Hand off', exact: true}).click();
        await expect(dialog.getByRole('status')).toHaveText('Waiting for the turn to end…');

        /* When */
        await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();

        /* Then */
        await expect(dialog).toHaveCount(0);
        await expect(sessionItem(page, S.loginFix).getByText(/^(Waiting|Handing off)…$/)).toHaveCount(0);
        const requests = await sessionHandoffRequests(app);
        expect(requests.cancel).toEqual([S.loginFix]);
        expect(requests.handOff).toHaveLength(1);
    });

    test('a failed hand-off shows why and that the session wasn’t moved, and offers Retry', async ({page, app}) => {
        /* Given */
        await setHostStub(app, 'sessionHandoff', {
            ...STUB_SESSION_HANDOFF,
            preview: {...STUB_SESSION_PREVIEW, busy: false},
            phases: [
                {kind: 'running', line: 'Handing off the checkout…'},
                {kind: 'failed', error: 'Couldn’t reach joris@devbox.local'},
            ],
        });
        await (await handOffButton(page, S.loginFix)).click();
        const dialog = handOffDialog(page);
        await expect(dialog).not.toContainText('Claude is mid-turn.');

        /* When */
        await dialog.getByRole('button', {name: 'Hand off', exact: true}).click();

        /* Then */
        const alert = dialog.getByRole('alert');
        await expect(alert).toContainText('Couldn’t reach joris@devbox.local');
        await expect(alert).toContainText('The session wasn’t moved.');
        await expect(dialog).toContainText('Handing off the checkout…');
        await expect(dialog.getByRole('button', {name: 'Retry'})).toBeEnabled();
    });
});

test.describe('VM transcripts', () => {
    test.use({fixture: vmTranscriptFixture()});

    test('a VM session’s row takes its title from the cached transcript, not “Remote Claude”', async ({page}) => {
        /* Then */
        await expect(sessionItem(page, S.vmWeb)).toContainText(LABEL.vmWeb);
        await expect(sessionItem(page, S.vmWeb)).not.toContainText(LABEL.remoteApi);
        await expect(sessionItem(page, S.remoteApi)).toContainText(LABEL.remoteApi);
    });
});

test.describe('VM project pages', () => {
    /** A shell on the VM host, beside its Claude session. */
    const VM_SHELL = sessionId('vm-shell');

    /** `vmTranscriptFixture` with a shell on the VM host too. */
    function vmShellFixture(): FixtureSpec {
        const spec = vmTranscriptFixture();
        return {
            ...spec,
            remotes: (spec.remotes ?? []).map((remote) =>
                remote.host === VM_REMOTE.host
                    ? {
                          ...remote,
                          sessions: [
                              ...(remote.sessions ?? []),
                              {id: VM_SHELL, kind: 'shell' as const, created: hoursAgo(8), lastOpened: hoursAgo(7)},
                          ],
                      }
                    : remote,
            ),
        };
    }

    /** acme-api's overview, as main would answer it for the VM project: read on the VM. */
    function vmOverview(): ProjectOverview {
        const acme = acmeOverview();
        return {
            ...acme,
            projectPath: VM_PATH,
            worktrees: acme.worktrees.map((worktree) => ({
                ...worktree,
                path: worktree.path.replace(P.acmeApi, VM_REMOTE.dir),
                running: [],
            })),
        };
    }

    /** Main says every remote row can open, so only the renderer keeps the shell and the agentless one off. */
    function vmWorkStub(): SessionWorkStub {
        return {
            canOpen: [S.vmWeb, VM_SHELL, S.remoteApi],
            snapshots: {[S.vmWeb]: {...LOGIN_FIX_WORK, sessionId: S.vmWeb}},
        };
    }

    test.use({
        fixture: vmShellFixture(),
        stubs: {projectOverview: {'apps/web': vmOverview()}, sessionWork: vmWorkStub()},
    });

    test('a VM project’s page shows its pull requests, plans and worktrees and the GitHub button, and an agentless remote’s shows only sessions and the remote note', async ({
        page,
        app,
    }) => {
        /* When */
        await openProjectPage(page, REMOTE_LABEL.vm);

        /* Then */
        const vm = projectPage(page, REMOTE_LABEL.vm);
        await expect(vm.getByText('VM', {exact: true})).toBeVisible();
        await expect(vm.getByRole('region', {name: 'Pull requests'}).locator('.pp-pr-title')).toHaveText([
            'Stop the login redirect loop',
            'Try a token-bucket rate limiter',
            'Bump express to 5.1',
        ]);
        await expect(
            vm.getByRole('region', {name: 'Plans & issues'}).getByRole('button', {name: 'Expand plan Login rework'}),
        ).toBeVisible();
        await expect(vm.getByRole('region', {name: 'Worktrees'}).locator('.pp-worktree-branch')).toHaveText([
            'main',
            'fix/1320',
            'rate-limiter',
            'cookie-store',
        ]);
        await expect(vm.getByText(REMOTE_NOTE, {exact: true})).toHaveCount(0);

        /* When */
        await vm.getByRole('button', {name: 'GitHub'}).click();

        /* Then */
        await expect.poll(() => openedExternally(app)).toEqual(['repository:' + VM_PATH]);

        /* When */
        await page.keyboard.press('Escape');
        await openProjectPage(page, REMOTE_LABEL.ssh);

        /* Then */
        const ssh = projectPage(page, REMOTE_LABEL.ssh);
        await expect(ssh.getByRole('region', {name: 'Sessions'})).toBeVisible();
        await expect(ssh.getByText(REMOTE_NOTE, {exact: true})).toBeVisible();
        await expect(ssh.getByRole('region', {name: 'Pull requests'})).toHaveCount(0);
        await expect(ssh.getByRole('region', {name: 'Plans & issues'})).toHaveCount(0);
        await expect(ssh.getByRole('region', {name: 'Worktrees'})).toHaveCount(0);
        await expect(ssh.getByRole('button', {name: 'GitHub'})).toHaveCount(0);
    });

    test('a VM Claude session’s meta line opens Session work, while a VM shell’s and an agentless remote’s say why not', async ({
        page,
        app,
    }) => {
        /* Given */
        await stubOpenTerminal(app);
        const trigger = sidebar(page).getByRole('button', {name: 'Open session work for ' + LABEL.vmWeb, exact: true});
        await expect(trigger).toHaveAttribute('title', 'Open session work · ⌘G');

        /* Then */
        await expect(sessionItem(page, VM_SHELL).getByRole('button', {name: /^Open session work for /})).toHaveCount(0);
        await expect(sessionItem(page, VM_SHELL).locator('.session-meta')).toHaveAttribute('title', VM_SHELL_REASON);
        await expect(sessionItem(page, S.remoteApi).getByRole('button', {name: /^Open session work for /})).toHaveCount(
            0,
        );
        await expect(sessionItem(page, S.remoteApi).locator('.session-meta')).toHaveAttribute('title', REMOTE_REASON);

        /* When */
        await trigger.click();

        /* Then */
        const work = page.getByRole('region', {name: /^Session work for /});
        await expect(work.getByRole('heading', {level: 1})).toHaveText('Work · ' + LABEL.vmWeb);
        await expect(sessionItem(page, S.vmWeb)).toHaveClass(/\bactive\b/);
        expect(await terminalsOpened(app)).toEqual([S.vmWeb]);
    });

    test('⌘-click on a VM project’s name asks to open its repository', async ({page, app}) => {
        /* When */
        await sessionItem(page, S.vmWeb)
            .getByTestId('project-link')
            .click({modifiers: ['Meta']});

        /* Then */
        await expect.poll(() => openedExternally(app)).toEqual(['repository:' + VM_PATH]);
        await expect(projectPage(page, REMOTE_LABEL.vm)).toHaveCount(0);
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

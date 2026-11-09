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
 * VM hosts (#276, #307): a remote whose host has a Switchboard agent is badged
 * VM and its page links to its VM in Settings, and an agentless one's page
 * offers to register its host as a VM. Settings → VMs lists the registered
 * VMs: Add a VM, Install agent with its progress, the setup checks and
 * terminal, the host settings, Rename and Remove. The agent channels answer
 * from the `agent` stub, so nothing here dials a host; the registry is the
 * real one (the fixture's agent remote registered by the migration), except
 * where an install has to land, where the `vmRegistry` stub keeps it. What
 * the parts say is unit tested in test/agent-host-view.test.ts and
 * test/vms-copy.test.ts, and the slices behind them in
 * test/agent-host-slice.test.ts and test/vms-slice.test.ts.
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
 * VM project pages (#276 stage 4): a VM session's row takes its title from
 * the `vm_transcripts` cache, seeded by `vmTranscriptFixture`; a VM project's page shows the GitHub
 * sections, plans and worktrees from a stubbed `projectOverview`, and its
 * GitHub button and ⌘-click ask to open the repository; a VM Claude session's
 * meta line opens Session work from the `sessionWork` stub, while a VM shell
 * and an agentless remote's rows say why not. Nothing here reads git or `gh`
 * on a VM. Which parts show is unit tested in test/project-page-vm.test.ts and
 * test/session-list-work-trigger.test.ts.
 *
 * Stage 5 (#276): the Schedules line on a local project's page and its copy's,
 * the hand-off dialog's "Run this project’s schedules on the VM", the Tasks
 * section on a VM project, and files dropped on a VM session's terminal. The
 * `vm-schedules:*` and `dropped-files:to-session` channels answer from the
 * `vmSchedules` and `droppedFiles` stubs, and BlaakTasks from a stand-in on
 * loopback, so nothing here reaches a VM. What the parts say is unit tested in
 * test/schedules-view.test.ts and test/dropped-files.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
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
    droppedFilesRequests,
    handoffRequests,
    openedExternally,
    pushRemoteStatus,
    sessionHandoffRequests,
    setHostStub,
    STUB_AGENT,
    STUB_HANDOFF,
    STUB_HANDOFF_HOST,
    STUB_SESSION_HANDOFF,
    stubVmHost,
    stubOpenTerminal,
    terminalInput,
    terminalsOpened,
    vmSchedulesRequests,
} from '../support/main-process';
import {sessionItem} from '../support/session-list';
import {answerDialogs, dialogsAsked} from '../support/native-dialogs';
import {cellPoint, expectTerminalText, hasTerminal} from '../support/terminal';
import {fakeBlaakTasks, switchBlaakTasksOn, TASK, TITLE, writeBlaakTasksConfig} from '../support/blaak-tasks';
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
import {SCHEDULES_CHOICE} from '../../src/renderer/ui/project-page/schedules-view';
import {posixQuote} from '../../src/domain/shell/quoting';
import {SEND} from '../../src/ipc/channels';
import type {FixtureHome, FixtureSpec} from '../support/fixture-home';
import type {HandoffStub, SessionWorkStub, VmSchedulesStub} from '../support/main-process';
import type {ScheduleLocation} from '../../src/application/services/vm-schedules';
import type {ProjectOverview} from '../../src/domain/project/overview';
import type {ElectronApplication, Locator, Page} from '@playwright/test';

const TARGET = `${REMOTE.user}@${REMOTE.host}:${REMOTE.dir}`;
const VM_PATH = `ssh://${VM_REMOTE.user}@${VM_REMOTE.host}/${VM_REMOTE.dir}`;
const COPY_PATH = `ssh://${COPY_REMOTE.user}@${COPY_REMOTE.host}/${COPY_REMOTE.dir}`;
/** The VM host's address, its key in Settings → VMs, and the host path the `agent:*` calls take for it. */
const VM_ADDRESS = `${VM_REMOTE.user}@${VM_REMOTE.host}`;
const VM_KEY = `${VM_ADDRESS}:22`;
const VM_HOST_PATH = `ssh://${VM_ADDRESS}`;
/** The agentless remote's host, as Register this host as a VM registers it. */
const SSH_ADDRESS = `${REMOTE.user}@${REMOTE.host}`;
const SSH_KEY = `${SSH_ADDRESS}:22`;

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

async function openGlobalSettings(page: Page): Promise<void> {
    await page.getByRole('button', {name: 'Global settings', exact: true}).click();
    await page.getByRole('menuitem', {name: 'All settings…'}).click();
    await expect(globalSettingsTitle(page)).toBeVisible();
}

function globalSettingsTitle(page: Page): Locator {
    return page.getByText('Global Settings', {exact: true});
}

/** A VM's row in Settings → VMs, by its key: `sv-vm-` and the key with anything but `a-zA-Z0-9_-` as `-`. */
function vmRow(page: Page, key: string): Locator {
    return page.locator('#sv-vm-' + key.replace(/[^a-zA-Z0-9_-]/g, '-'));
}

/** The head of a VM's row, which opens and closes its controls. */
function vmHead(page: Page, key: string): Locator {
    return vmRow(page, key).locator('.vm-row-head');
}

/** Settings → VMs, open at a VM's controls. */
async function openVm(page: Page, key: string): Promise<void> {
    await openGlobalSettings(page);
    await vmHead(page, key).click();
    await expect(vmHead(page, key)).toHaveAttribute('aria-expanded', 'true');
}

/** A remote project page's "On <VM> · Manage in Settings". */
function manageInSettings(projectPage: Locator): Locator {
    return projectPage.getByRole('button', {name: /Manage in Settings$/});
}

function handOffDialog(page: Page): Locator {
    return page.getByRole('dialog', {name: 'Hand off to ' + STUB_HANDOFF_HOST.label});
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

test.describe('VM hosts', () => {
    test.use({fixture: vmFixture()});

    test('Settings lists the registered VM with its agent line and opens it to its controls; a host with an agent is badged VM in the Projects modal and on its page, an agentless one keeps SSH and offers to register its host; and a VM project’s Manage in Settings and its project settings’ This VM open Settings at its VM', async ({
        page,
    }) => {
        /* When */
        await openGlobalSettings(page);

        /* Then */
        const list = page.getByRole('list', {name: 'Registered VMs'});
        await expect(list.getByRole('listitem')).toHaveCount(1);
        const row = vmRow(page, VM_KEY);
        await expect(row.locator('.vm-row-name')).toHaveText(VM_ADDRESS);
        // The fixture's agent is not this build's version, and no link to it is open.
        await expect(row.locator('.vm-row-line')).toHaveText('Update available · Offline');
        await expect(vmHead(page, VM_KEY)).toHaveAttribute('aria-expanded', 'false');
        await expect(row.getByRole('button', {name: 'Open setup terminal'})).toHaveCount(0);

        /* When */
        await vmHead(page, VM_KEY).click();

        /* Then */
        await expect(vmHead(page, VM_KEY)).toHaveAttribute('aria-expanded', 'true');
        await expect(row).toContainText('Agent 0.0.0-e2e runs here; this app has a newer one.');
        await expect(row.getByRole('button', {name: 'Update agent'})).toBeEnabled();
        await expect(row.getByRole('button', {name: 'Open setup terminal'})).toBeVisible();
        await expect(row.getByRole('button', {name: 'Check again'})).toBeVisible();
        await expect(row.getByRole('button', {name: 'Remove ' + VM_ADDRESS})).toBeVisible();

        /* When */
        await vmHead(page, VM_KEY).click();
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
            `Runs on a Switchboard agent on ${VM_ADDRESS}`,
        );
        await expect(manageInSettings(vm)).toHaveText(`On ${VM_ADDRESS} · Manage in Settings`);
        await expect(vm.getByRole('region', {name: 'Setup'})).toHaveCount(0);
        await expect(vm.getByRole('button', {name: 'Install agent'})).toHaveCount(0);
        await expect(vm.getByRole('button', {name: 'Register this host as a VM'})).toHaveCount(0);

        /* When */
        await page.keyboard.press('Escape');
        await openProjectPage(page, REMOTE_LABEL.ssh);

        /* Then */
        const ssh = projectPage(page, REMOTE_LABEL.ssh);
        await expect(ssh.getByText('VM', {exact: true})).toHaveCount(0);
        await expect(ssh.getByRole('button', {name: 'Register this host as a VM'})).toBeVisible();
        await expect(manageInSettings(ssh)).toHaveCount(0);
        await expect(ssh.getByRole('button', {name: 'Install agent'})).toHaveCount(0);
        await expect(ssh.getByRole('region', {name: 'Setup'})).toHaveCount(0);

        /* When */
        await page.keyboard.press('Escape');
        await openProjectPage(page, REMOTE_LABEL.vm);
        await manageInSettings(projectPage(page, REMOTE_LABEL.vm)).click();

        /* Then */
        await expect(globalSettingsTitle(page)).toBeVisible();
        await expect(vmHead(page, VM_KEY)).toHaveAttribute('aria-expanded', 'true');
        await expect(vmRow(page, VM_KEY).getByRole('button', {name: 'Open setup terminal'})).toBeVisible();
        await expect(vmRow(page, VM_KEY)).toBeInViewport();

        /* When */
        await vmHead(page, VM_KEY).click();
        await openProjectPage(page, REMOTE_LABEL.vm);
        await projectPage(page, REMOTE_LABEL.vm).getByRole('button', {name: 'Settings', exact: true}).click();

        /* Then */
        const thisVm = page
            .getByRole('region', {name: 'Settings for ' + REMOTE_LABEL.vm})
            .getByRole('region', {name: 'This VM'});
        await expect(thisVm).toContainText(`On ${VM_ADDRESS}`);
        await expect(thisVm.getByLabel('Host instructions')).toHaveCount(0);
        await expect(thisVm.getByLabel('Base folder for copies')).toHaveCount(0);

        /* When */
        await thisVm.getByRole('button', {name: 'Manage in Settings'}).click();

        /* Then */
        await expect(globalSettingsTitle(page)).toBeVisible();
        await expect(vmHead(page, VM_KEY)).toHaveAttribute('aria-expanded', 'true');
    });

    test('Register this host as a VM on an agentless remote’s page registers its host, and opens Settings at it with Install agent', async ({
        page,
    }) => {
        /* Given */
        await openProjectPage(page, REMOTE_LABEL.ssh);

        /* When */
        await projectPage(page, REMOTE_LABEL.ssh).getByRole('button', {name: 'Register this host as a VM'}).click();

        /* Then */
        await expect(globalSettingsTitle(page)).toBeVisible();
        const row = vmRow(page, SSH_KEY);
        await expect(vmHead(page, SSH_KEY)).toHaveAttribute('aria-expanded', 'true');
        await expect(row.locator('.vm-row-name')).toHaveText(SSH_ADDRESS);
        await expect(row).toContainText('No agent yet');
        await expect(row.getByRole('button', {name: 'Install agent'})).toBeEnabled();
        await expect(page.getByRole('list', {name: 'Registered VMs'}).getByRole('listitem')).toHaveCount(2);

        /* When */
        await openProjectPage(page, REMOTE_LABEL.ssh);

        /* Then */
        const ssh = projectPage(page, REMOTE_LABEL.ssh);
        await expect(manageInSettings(ssh)).toHaveText(`On ${SSH_ADDRESS} · Manage in Settings`);
        await expect(ssh.getByRole('button', {name: 'Register this host as a VM'})).toHaveCount(0);
    });
});

test.describe('Settings → VMs', () => {
    test.use({fixture: vmFixture()});

    test('Add a VM adds a new one, open to Install agent', async ({page}) => {
        /* Given */
        await openGlobalSettings(page);
        await page.getByRole('button', {name: 'Add a VM…'}).click();
        const form = page.locator('form.vm-add');

        /* When */
        await form.getByLabel('User').fill('dev');
        await form.getByLabel('Host').fill('build.local');
        await form.getByLabel('Port').fill('2222');
        await form.getByLabel('Name (optional)').fill('Build VM');
        await form.getByRole('button', {name: 'Add VM'}).click();

        /* Then */
        await expect(form).toHaveCount(0);
        const key = 'dev@build.local:2222';
        const row = vmRow(page, key);
        await expect(row.locator('.vm-row-name')).toHaveText('Build VM');
        await expect(row.locator('.vm-row-line')).toHaveText('dev@build.local:2222 · No agent yet');
        await expect(vmHead(page, key)).toHaveAttribute('aria-expanded', 'true');
        await expect(row.getByRole('button', {name: 'Install agent'})).toBeEnabled();
        await expect(page.getByRole('list', {name: 'Registered VMs'}).getByRole('listitem')).toHaveCount(2);
    });

    test.describe('installing', () => {
        test.use({stubs: {vmRegistry: {hosts: [stubVmHost('dev', 'build.local')]}}});

        const NEW_KEY = 'dev@build.local:22';
        const NEW_PATH = 'ssh://dev@build.local';

        test('Install agent streams its progress lines on the VM’s row, then shows its agent and setup', async ({
            page,
            app,
        }) => {
            /* Given */
            const lines = ['Checking the host…', 'Copying the agent (0.0.0-e2e)…', 'Starting the service…'];
            await setHostStub(app, 'agent', {
                ...STUB_AGENT,
                status: {installed: '0.0.0-e2e', current: true, connected: true},
                installLines: lines,
                installLineDelayMs: 150,
            });
            await openVm(page, NEW_KEY);
            const row = vmRow(page, NEW_KEY);
            await expect(row.locator('.vm-row-line')).toHaveText('No agent yet');
            await expect(row.getByRole('button', {name: 'Open setup terminal'})).toHaveCount(0);

            /* When */
            await row.getByRole('button', {name: 'Install agent'}).click();

            /* Then */
            await expect(row.getByRole('button', {name: 'Installing…', exact: true})).toBeDisabled();
            await expect(row.locator('.vm-row-line')).toHaveText('Installing…');
            for (const line of lines) await expect(row).toContainText(line);
            await expect(row.locator('.vm-row-line')).toHaveText('Agent 0.0.0-e2e · Connected');
            await expect(row.getByText('Ready', {exact: true})).toBeVisible();
            await expect(row.getByRole('button', {name: 'Install agent'})).toHaveCount(0);
            await expect(row.getByLabel('Host instructions')).toHaveValue(STUB_AGENT.hostSettings!.instructions);
            expect((await agentRequests(app)).install).toEqual([NEW_PATH]);
        });
    });

    test('a VM’s host settings show what its agent has and save a change to it, Open setup terminal says why it didn’t open, and Rename gives it a name that an empty one takes back to the address', async ({
        page,
        app,
    }) => {
        /* When */
        await openVm(page, VM_KEY);

        /* Then */
        const row = vmRow(page, VM_KEY);
        const copyConfig = row.getByRole('checkbox', {name: 'Copy my Claude config to this VM'});
        await expect(row.getByLabel('Host instructions')).toHaveValue(STUB_AGENT.hostSettings!.instructions);
        await expect(copyConfig).not.toBeChecked();
        await expect(row.getByLabel('Base folder for copies')).toHaveValue('~/projects');

        /* When */
        await row.getByLabel('Base folder for copies').fill('~/work');
        await row.getByLabel('Base folder for copies').press('Enter');

        /* Then */
        await expect
            .poll(async () => (await agentRequests(app)).setHostSettings)
            .toEqual([{projectPath: VM_HOST_PATH, change: {baseFolder: '~/work'}}]);
        await expect(row.getByLabel('Base folder for copies')).toHaveValue('~/work');

        /* When */
        await copyConfig.locator('..').click();

        /* Then */
        await expect(copyConfig).toBeChecked();

        /* When */
        await row.getByLabel('Host instructions').fill('Use the shared cache.');
        await row.getByLabel('Base folder for copies').focus();

        /* Then */
        await expect
            .poll(async () => (await agentRequests(app)).setHostSettings)
            .toEqual([
                {projectPath: VM_HOST_PATH, change: {baseFolder: '~/work'}},
                {projectPath: VM_HOST_PATH, change: {copyConfig: true}},
                {projectPath: VM_HOST_PATH, change: {instructions: 'Use the shared cache.'}},
            ]);

        /* When */
        await row.getByRole('button', {name: 'Open setup terminal'}).click();

        /* Then */
        await expect(row.getByRole('alert')).toHaveText('No setup terminal in the harness');
        expect((await agentRequests(app)).openSetupTerminal).toEqual([VM_HOST_PATH]);

        /* When */
        const name = row.getByLabel('Rename ' + VM_ADDRESS);
        await expect(name).toHaveValue('');
        await name.fill('Dev VM');
        await name.press('Enter');

        /* Then */
        await expect(row.locator('.vm-row-name')).toHaveText('Dev VM');
        await expect(row.locator('.vm-row-address')).toHaveText(VM_ADDRESS + ' · ');
        await expect(row.getByLabel('Rename Dev VM')).toHaveValue('Dev VM');

        /* When */
        await row.getByLabel('Rename Dev VM').fill('');
        await row.getByLabel('Rename Dev VM').press('Enter');

        /* Then */
        await expect(row.locator('.vm-row-name')).toHaveText(VM_ADDRESS);
        await expect(row.locator('.vm-row-address')).toHaveCount(0);
    });

    test('Remove asks first, keeps the VM when declined, and once confirmed forgets it and its projects', async ({
        page,
    }) => {
        /* Given */
        await openVm(page, VM_KEY);
        const remove = vmRow(page, VM_KEY).getByRole('button', {name: 'Remove ' + VM_ADDRESS});
        await answerDialogs(page, false);

        /* When */
        await remove.click();

        /* Then */
        expect(await dialogsAsked(page)).toEqual([
            `Remove “${VM_ADDRESS}”?\n\nIts projects leave the list here. The agent and its sessions keep running on the VM, ` +
                'and adding it again brings them back.',
        ]);
        await expect(vmRow(page, VM_KEY)).toBeVisible();

        /* When */
        await answerDialogs(page, true);
        await remove.click();

        /* Then */
        await expect(vmRow(page, VM_KEY)).toHaveCount(0);
        await expect(page.getByText('No VM is registered yet.', {exact: true})).toBeVisible();

        /* When */
        await openProjects(page);

        /* Then */
        await expect(pickerName(page, REMOTE_LABEL.ssh)).toBeVisible();
        await expect(pickerName(page, REMOTE_LABEL.vm)).toHaveCount(0);
    });
});

test.describe('project hand-off', () => {
    test.use({fixture: handoffFixture(), stubs: {handoff: STUB_HANDOFF}});

    function thisCopy(page: Page): Locator {
        return projectPage(page, REMOTE_LABEL.copy).getByRole('region', {name: 'This copy'});
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
            {
                localPath: home.projectPath(P.acmeApi),
                hostKey: STUB_HANDOFF_HOST.key,
                ticked: ['.env.local'],
                choices: {},
            },
        ]);

        /* When */
        await dialog.getByRole('button', {name: 'Open the copy'}).click();

        /* Then */
        await expect(dialog).toHaveCount(0);
        await expect(projectPage(page, REMOTE_LABEL.copy)).toBeVisible();
    });

    test('a local project lists its copy under On VMs and the copy’s page links back with Copy of …; Bring back streams its progress and names the branch in the new worktree; Remove copy on a clean copy asks to confirm, and removes it only once confirmed', async ({
        page,
        app,
        home,
    }) => {
        /* Given */
        const lines = ['Fetching from the copy…', 'Adding a worktree for from-vm…'];
        await setHostStub(app, 'handoff', linkedCopy(home, {bringBackLines: lines, lineDelayMs: 150}));

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

        /* When */
        await copy.click();
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

        /* When */
        await answerDialogs(page, false);
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
});

test.describe('session hand-off', () => {
    test.use({fixture: handoffFixture(), stubs: {handoff: STUB_HANDOFF}});

    /** Hand off to… on a row; the row's buttons show while the pointer is over it. */
    async function handOffButton(page: Page, sessionId: string): Promise<Locator> {
        const row = sessionItem(page, sessionId);
        await row.hover();
        return row.getByRole('button', {name: 'Hand off to…', exact: true});
    }

    test('Hand off to… in a local Claude session’s tray opens the hand-off dialog for it', async ({page, home}) => {
        /* Given */
        await openSession(page, home, LABEL.loginFix, S.loginFix);

        /* When */
        // In the session tray (#343), which hovering the bar opens.
        await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();
        await page.getByRole('region', {name: 'Session tools'}).getByRole('button', {name: 'Hand off…'}).click();

        /* Then */
        const dialog = handOffDialog(page);
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(LABEL.loginFix);
    });

    test('a busy session waits for its turn with Cancel, shows Waiting… and Handing off… on its row, then continues on the VM', async ({
        page,
        app,
    }) => {
        /* Given */
        await setHostStub(app, 'sessionHandoff', {...STUB_SESSION_HANDOFF, phaseDelayMs: 400, waitingMs: 1200});
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

    test('a VM session’s row takes its title from the cached transcript; a VM project’s page shows its pull requests, plans and worktrees and the GitHub button, and an agentless remote’s only sessions and the remote note; a VM Claude session’s meta line opens Session work, while a VM shell’s and an agentless remote’s say why not', async ({
        page,
        app,
    }) => {
        /* Given */
        await stubOpenTerminal(app);

        /* Then */
        // The VM session's title comes from the `vm_transcripts` cache, not “Remote Claude”.
        await expect(sessionItem(page, S.vmWeb)).toContainText(LABEL.vmWeb);
        await expect(sessionItem(page, S.vmWeb)).not.toContainText(LABEL.remoteApi);
        await expect(sessionItem(page, S.remoteApi)).toContainText(LABEL.remoteApi);
        const trigger = sidebar(page).getByRole('button', {name: 'Open session work for ' + LABEL.vmWeb, exact: true});
        await expect(trigger).toHaveAttribute('title', 'Open session work · ⌘G');
        await expect(sessionItem(page, VM_SHELL).getByRole('button', {name: /^Open session work for /})).toHaveCount(0);
        await expect(sessionItem(page, VM_SHELL).locator('.session-meta')).toHaveAttribute('title', VM_SHELL_REASON);
        await expect(sessionItem(page, S.remoteApi).getByRole('button', {name: /^Open session work for /})).toHaveCount(
            0,
        );
        await expect(sessionItem(page, S.remoteApi).locator('.session-meta')).toHaveAttribute('title', REMOTE_REASON);

        /* When */
        await openProjectPage(page, REMOTE_LABEL.vm);

        /* Then */
        const vm = projectPage(page, REMOTE_LABEL.vm);
        await expect(vm.getByText('VM', {exact: true})).toBeVisible();
        await expect(vm.getByRole('region', {name: 'Pull requests'}).locator('.pp-pr-title')).toHaveText([
            'Try a token-bucket rate limiter',
            'Bump express to 5.1',
            'Stop the login redirect loop',
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

        /* When */
        await trigger.click();

        /* Then */
        const work = page.getByRole('region', {name: /^Session work for /});
        await expect(work.getByRole('heading', {level: 1})).toHaveText('Work · ' + LABEL.vmWeb);
        await expect(sessionItem(page, S.vmWeb)).toHaveClass(/\bactive\b/);
        expect(await terminalsOpened(app)).toEqual([S.vmWeb]);
    });
});

test.describe('stage 5', () => {
    /** Where acme-api's schedules run: on this Mac, or in its copy. */
    function scheduleLocation(home: FixtureHome, runsOn: 'mac' | 'copy', count = 3): ScheduleLocation {
        return {
            localPath: home.projectPath(P.acmeApi),
            runsOn: runsOn === 'mac' ? {kind: 'mac'} : {kind: 'vm', copyPath: COPY_PATH},
            count,
        };
    }

    /** The schedules stub, answering `location` for acme-api and its copy alike. */
    function schedulesAt(location: ScheduleLocation, runOn: VmSchedulesStub['runOn'] = location): VmSchedulesStub {
        return {where: {[location.localPath]: location, [COPY_PATH]: location}, runOn};
    }

    function schedulesPicker(page: Page, label: string): Locator {
        return projectPage(page, label)
            .getByRole('region', {name: 'Schedules'})
            .getByRole('combobox', {name: 'Where the schedules run'});
    }

    test.describe('where schedules run', () => {
        test.use({fixture: handoffFixture(), stubs: {handoff: STUB_HANDOFF}});

        test('a local project with a copy and schedules runs them on this Mac, picking the copy moves them there, and the copy’s page offers Run here and Run on the Mac, which moves them back', async ({
            page,
            app,
            home,
        }) => {
            /* Given */
            const local = home.projectPath(P.acmeApi);
            await setHostStub(app, 'handoff', linkedCopy(home));
            await setHostStub(
                app,
                'vmSchedules',
                schedulesAt(scheduleLocation(home, 'mac'), scheduleLocation(home, 'copy')),
            );

            /* When */
            await openProjectPage(page, P.acmeApi);

            /* Then */
            const picker = schedulesPicker(page, P.acmeApi);
            await expect(projectPage(page, P.acmeApi).getByRole('region', {name: 'Schedules'})).toContainText(
                '3 schedules',
            );
            await expect(picker.locator('option')).toHaveText(['Run on this Mac', 'Run on joris@devbox.local (copy)']);
            await expect(picker.locator('option:checked')).toHaveText('Run on this Mac');

            /* When */
            await picker.selectOption({label: 'Run on joris@devbox.local (copy)'});

            /* Then */
            await expect(picker.locator('option:checked')).toHaveText('Run on joris@devbox.local (copy)');
            expect((await vmSchedulesRequests(app)).runOn).toEqual([{localPath: local, copyPath: COPY_PATH}]);

            /* When */
            await setHostStub(
                app,
                'vmSchedules',
                schedulesAt(scheduleLocation(home, 'copy'), scheduleLocation(home, 'mac')),
            );
            await page.keyboard.press('Escape');
            await openProjectPage(page, REMOTE_LABEL.copy);

            /* Then */
            const copyPicker = schedulesPicker(page, REMOTE_LABEL.copy);
            await expect(copyPicker.locator('option')).toHaveText(['Run here', 'Run on the Mac']);
            await expect(copyPicker.locator('option:checked')).toHaveText('Run here');
            expect((await vmSchedulesRequests(app)).where).toContain(COPY_PATH);

            /* When */
            await copyPicker.selectOption({label: 'Run on the Mac'});

            /* Then */
            await expect(copyPicker.locator('option:checked')).toHaveText('Run on the Mac');
            expect((await vmSchedulesRequests(app)).runOn).toEqual([
                {localPath: local, copyPath: COPY_PATH},
                {localPath: local, copyPath: null},
            ]);
        });
    });

    test.describe('the hand-off’s schedules choice', () => {
        test.use({fixture: handoffFixture(), stubs: {handoff: STUB_HANDOFF}});

        test('with schedules the dialog offers to run them on the VM, ticked, and the hand-off carries that choice', async ({
            page,
            app,
            home,
        }) => {
            /* Given */
            await setHostStub(app, 'vmSchedules', schedulesAt(scheduleLocation(home, 'mac', 2)));
            await openProjectPage(page, P.acmeApi);
            await projectPage(page, P.acmeApi).getByRole('button', {name: 'Hand off to…'}).click();
            const dialog = handOffDialog(page);
            await expect(dialog.getByRole('checkbox', {name: SCHEDULES_CHOICE, exact: true})).toBeChecked();
            await expect(dialog).toContainText('2 schedules. Ticked, they stop running on this Mac.');

            /* When */
            await dialog.getByRole('button', {name: 'Hand off', exact: true}).click();

            /* Then */
            await expect(dialog.getByRole('status')).toHaveText('Handed off');
            expect((await handoffRequests(app)).handOff.map((request) => request.choices)).toEqual([
                {schedulesOnVm: true},
            ]);
        });
    });

    test.describe('tasks on VM projects', () => {
        test.use({
            fixture: vmFixture(),
            stubs: {projectOverview: {'apps/web': {...acmeOverview(), projectPath: VM_PATH, worktrees: []}}},
        });

        test('a VM project’s page lists the task linked to it', async ({page, home}) => {
            /* Given */
            const blaakTasks = await fakeBlaakTasks();
            try {
                writeBlaakTasksConfig(home, blaakTasks.url);
                await switchBlaakTasksOn(page, blaakTasks.url);
                await page.evaluate(({task, projectPath}) => window.api.setTaskRepo(task, projectPath), {
                    task: TASK,
                    projectPath: VM_PATH,
                });

                /* When */
                await openProjectPage(page, REMOTE_LABEL.vm);

                /* Then */
                const tasks = projectPage(page, REMOTE_LABEL.vm).getByRole('region', {name: 'Tasks'});
                await expect(tasks.locator(`[data-task-id="${TASK}"]`)).toContainText(TITLE);
            } finally {
                await blaakTasks.close();
            }
        });
    });

    test.describe('files dropped on a VM terminal', () => {
        test.use({fixture: vmTranscriptFixture()});

        /** Two files on disk, one with a quote in its name, as `File`s the app resolves the paths of. */
        async function filesToDrop(page: Page, home: FixtureHome): Promise<string[]> {
            const dir = path.join(home.home, 'Drop zone');
            fs.mkdirSync(dir, {recursive: true});
            const files = [path.join(dir, "Bob's notes.txt"), path.join(dir, 'plain.txt')];
            for (const file of files) fs.writeFileSync(file, 'x');
            await page.evaluate(() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.id = 'e2e-drop-files';
                input.style.display = 'none';
                document.body.appendChild(input);
            });
            await page.setInputFiles('#e2e-drop-files', files);
            return files;
        }

        /** Drop the picked files on the session's terminal, as Finder does. */
        async function dropOn(page: Page, sessionId: string): Promise<void> {
            await expect.poll(() => hasTerminal(page, sessionId)).toBe(true);
            const point = await cellPoint(page, sessionId, 10, 5);
            await page.evaluate(
                ([x, y]) => {
                    const target = document.elementFromPoint(x, y)!;
                    for (const type of ['dragenter', 'drop']) {
                        const transfer = new DataTransfer();
                        if (type === 'drop') {
                            for (const file of (document.getElementById('e2e-drop-files') as HTMLInputElement).files!)
                                transfer.items.add(file);
                        }
                        target.dispatchEvent(
                            new DragEvent(type, {dataTransfer: transfer, bubbles: true, cancelable: true}),
                        );
                    }
                },
                [point.x, point.y],
            );
        }

        const VM_DROPS = ["/home/joris/.switchboard/drops/Bob's notes.txt", '/home/joris/.switchboard/drops/plain.txt'];

        test('a VM session uploads the dropped files, says so while it does, and types their paths on the VM, while a local session types their own paths and uploads nothing', async ({
            page,
            app,
            home,
        }) => {
            /* Given */
            await stubOpenTerminal(app);
            await setHostStub(app, 'droppedFiles', {result: {ok: true, paths: VM_DROPS}, delayMs: 500});
            const files = await filesToDrop(page, home);
            await sessionItem(page, S.vmWeb).click();

            /* When */
            await dropOn(page, S.vmWeb);

            /* Then */
            const toast = page.getByTestId('drop-upload');
            await expect(toast).toHaveText('Uploading 2 files to the VM…');
            await expect(toast).toHaveCount(0);
            await expect.poll(() => terminalInput(app, S.vmWeb)).toBe(VM_DROPS.map(posixQuote).join(' '));
            expect(await droppedFilesRequests(app)).toEqual([{sessionId: S.vmWeb, localPaths: files}]);

            /* When */
            await sessionRow(page, LABEL.loginFix).first().click();
            await dropOn(page, S.loginFix);

            /* Then */
            await expect.poll(() => terminalInput(app, S.loginFix)).toBe(files.map(posixQuote).join(' '));
            expect(await droppedFilesRequests(app)).toHaveLength(1);
            await expect(toast).toHaveCount(0);
        });
    });
});

forEachAppearance(() => {
    test('remote card, connecting, then retrying, then failed', async ({page, home, app}) => {
        /* When */
        await openRemoteSession(page, home, LABEL.remoteApi, S.remoteApi);

        /* Then */
        await expect(page.getByText('Connecting', {exact: true})).toBeVisible();
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

        /* Then */
        // Said twice: on the card, and as the header's status.
        await expect(page.getByText('Reconnecting in 30s', {exact: true})).toHaveCount(2);
        await expect(terminalStatus(page)).toHaveText('Reconnecting in 30s');
        await expectScreen(page, 'remote-retrying');

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

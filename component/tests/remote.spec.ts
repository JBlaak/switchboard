/**
 * Remote and VM projects in the renderer, against main's answers: the
 * connection card's phases, and everything VM (#276, #307).
 *
 * The fake `ssh` dialled through the login shell, and main's reconnect loop
 * behind the card, are e2e tested (e2e/tests/remote.spec.ts). What the card
 * says and when (phases, countdowns, the progress bar's runs, the green beat)
 * is unit tested in test/remote-card.test.ts and
 * test/remote-status-render.test.ts; here main's statuses arrive as events.
 *
 * VM hosts: a remote whose host has a Switchboard agent is badged VM and its
 * page links to its VM in Settings, and an agentless one's page offers to
 * register its host as a VM. Settings → VMs lists the registered VMs: Add a
 * VM, Install agent with its progress, the host settings, Rename and Remove.
 * Project hand-off (stage 2): Hand off to… on a local project's page, the
 * copies it lists under On VMs and the copy's link back, a copy's Bring back
 * and Remove copy. Session hand-off (stage 3): Hand off to… in a local Claude
 * session's tray, the wait for the turn to end with Cancel, the row's marker.
 * Bring back: on a Claude session on a VM copy, Update it, and Delete and
 * recreate…, which asks once more. VM project pages (stage 4): a VM row's
 * title from its cached transcript, a VM project's GitHub sections, and which
 * rows open Session work. Stage 5: where schedules run, the hand-off's
 * schedules choice, the Tasks section on a VM project, and files dropped on a
 * VM session's terminal.
 *
 * Main's VM side answers from the e2e stubs' shapes and defaults
 * (support/vm-main.ts), its projects and settings from support/main-world.ts.
 * What the parts say is unit tested in test/agent-host-view.test.ts,
 * test/vms-copy.test.ts, test/handoff-view.test.ts,
 * test/session-handoff-view.test.ts, test/session-bring-back-ui.test.ts,
 * test/project-page-vm.test.ts, test/session-list-work-trigger.test.ts,
 * test/schedules-view.test.ts and test/dropped-files.test.ts, and the slices
 * behind them beside those.
 */
import {test as worldTest, expect, sessionRow as row, worldOf} from '../support/main-world';
import {VmMain, vmEntry, type VmEntry} from '../support/vm-main';
import {dialog, sessionRow, sidebar, terminalHeader, terminalStatus} from '../../e2e/support/app';
import {
    STUB_AGENT,
    STUB_BRING_BACK_WORKTREE,
    STUB_HANDOFF,
    STUB_HANDOFF_HOST,
    STUB_SESSION_HANDOFF,
} from '../../e2e/support/main-process';
import type {HandoffStub, VmSchedulesStub} from '../../e2e/support/main-process';
import {sessionItem} from '../../e2e/support/session-list';
import {answerDialogs, dialogsAsked} from '../../e2e/support/native-dialogs';
import {cellPoint, hasTerminal} from '../../e2e/support/terminal';
import {TASK, TITLE} from '../../e2e/support/blaak-tasks';
import {COPY_REMOTE, LABEL, P, REMOTE, REMOTE_LABEL, S, VM_REMOTE} from '../../e2e/fixtures/standard';
import {acmeOverview} from '../../e2e/fixtures/plans';
import {LOGIN_FIX_WORK} from '../../e2e/fixtures/session-work';
import {sessionId} from '../../e2e/support/fixture-home';
import {captured, fixtureProjectPath, type CapturedFixture} from '../fixtures/captured';
import {REMOTE_REASON, VM_SHELL_REASON} from '../../src/renderer/ui/session-list/work-trigger';
import {REMOTE_NOTE} from '../../src/renderer/ui/project-page/page-state';
import {SCHEDULES_CHOICE} from '../../src/renderer/ui/project-page/schedules-view';
import {posixQuote} from '../../src/domain/shell/quoting';
import {parseTaskDetail} from '../../src/domain/tasks/parse';
import {encodeProjectPath} from '../../src/domain/project/project-path';
import type {FakeApi} from '../support/fake-api';
import type {ScheduleLocation} from '../../src/application/services/vm-schedules';
import type {ProjectOverview} from '../../src/domain/project/overview';
import type {Project} from '../../src/domain/project/project';
import type {SessionWorkSnapshot} from '../../src/domain/session-work/model';
import type {Locator, Page} from '@playwright/test';

const TARGET = `${REMOTE.user}@${REMOTE.host}:${REMOTE.dir}`;
const VM_PATH = `ssh://${VM_REMOTE.user}@${VM_REMOTE.host}/${VM_REMOTE.dir}`;
const COPY_PATH = `ssh://${COPY_REMOTE.user}@${COPY_REMOTE.host}/${COPY_REMOTE.dir}`;
/** The VM host's address, its key in Settings → VMs, and the host path the `agent*` calls take for it. */
const VM_ADDRESS = `${VM_REMOTE.user}@${VM_REMOTE.host}`;
const VM_KEY = `${VM_ADDRESS}:22`;
const VM_HOST_PATH = `ssh://${VM_ADDRESS}`;
/** The agentless remote's host, as Register this host as a VM registers it. */
const SSH_ADDRESS = `${REMOTE.user}@${REMOTE.host}`;
const SSH_KEY = `${SSH_ADDRESS}:22`;
const ACME = fixtureProjectPath(P.acmeApi);
/** A shell on the VM host, beside its Claude session. */
const VM_SHELL = sessionId('vm-shell');

// ── Main's side ──

interface RemoteOptions {
    /** Main's VM side as it stands at launch: the registry, and any stub other than its default. */
    vmSetup: Partial<Pick<VmMain, 'vms' | 'handoff' | 'vmSchedules'>>;
}

const VMS = new WeakMap<FakeApi, VmMain>();

const test = worldTest.extend<RemoteOptions & {vm: VmMain}>({
    // The registry as main's migration leaves it: each agent remote's host registered, on an older agent, offline.
    vmSetup: [{}, {option: true}],
    api: async ({api, vmSetup, answers}, use) => {
        const vm = new VmMain(api, worldOf(api)).install();
        vm.vms = registeredAgentHosts();
        Object.assign(vm, structuredClone(vmSetup));
        for (const [name, answer] of Object.entries(answers)) {
            api.handle(name as never, (typeof answer === 'function' ? answer : () => answer) as never);
        }
        VMS.set(api, vm);
        await use(api);
    },
    vm: async ({api}, use) => {
        await use(VMS.get(api)!);
    },
});

/** The hosts of the world's agent remotes, one entry each, as the real registry's migration registers them. */
function registeredAgentHosts(): VmEntry[] {
    return [vmEntry(VM_REMOTE.user, VM_REMOTE.host, 22, {agent: '0.0.0-e2e'})];
}

/** A remote project as main lists it from settings. */
function remoteProject(path: string, change: Partial<Project> = {}): Project {
    return {projectPath: path, folder: encodeProjectPath(path), sessions: [], remote: true, ...change};
}

/** Projects as main lists them: the most recent activity first, empty ones last. */
function listed(projects: Project[]): Project[] {
    const newest = (project: Project) => Math.max(0, ...project.sessions.map((s) => Date.parse(s.modified)));
    return [...projects].sort((a, b) => {
        if (!a.sessions.length !== !b.sessions.length) return a.sessions.length ? -1 : 1;
        return newest(b) - newest(a);
    });
}

function fixtureOf(projects: Project[]): CapturedFixture {
    const all = listed(projects);
    return {
        projects: all.map((p) => ({...p, sessions: p.sessions.filter((s) => !s.archived)})),
        projectsWithArchived: all,
    };
}

/** The standard projects with a second remote, on a VM host, beside the agentless one. */
function vmProjects(): Project[] {
    return [...captured('standard').projectsWithArchived, remoteProject(VM_PATH, {agent: true})];
}

/** `vmProjects` with a copy of acme-api on the VM host, as a hand-off leaves it. */
function handoffProjects(): Project[] {
    return [...vmProjects(), remoteProject(COPY_PATH, {agent: true, copyOf: ACME})];
}

/** A Claude session on a VM project, titled from the VM's transcript. */
function vmClaudeRow(projectPath: string) {
    return row({
        sessionId: S.vmWeb,
        projectPath,
        summary: LABEL.vmWeb,
        firstPrompt: LABEL.vmWeb,
        created: '2026-06-10T08:00:00.000Z',
        modified: '2026-06-10T10:00:00.000Z',
        messageCount: 8,
        type: 'remote',
        remoteKind: 'claude',
    });
}

/** `vmProjects` with one Claude session on the VM host, whose transcript the Mac fetched before. */
function vmTranscriptProjects(): Project[] {
    return vmProjects().map((project) =>
        project.projectPath === VM_PATH ? {...project, sessions: [vmClaudeRow(VM_PATH)]} : project,
    );
}

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

/** The global settings, on the page that lists the VMs. */
async function openVmSettings(page: Page): Promise<void> {
    await page.getByRole('button', {name: 'Global settings', exact: true}).click();
    await page.getByRole('menuitem', {name: 'All settings…'}).click();
    await expect(globalSettingsTitle(page)).toBeVisible();
    await page.getByRole('tab', {name: 'Phone & VMs', exact: true}).click();
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
    await openVmSettings(page);
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
function linkedCopy(change: Partial<HandoffStub> = {}): HandoffStub {
    return {
        ...STUB_HANDOFF,
        copies: {
            [ACME]: [{copyPath: COPY_PATH, hostKey: STUB_HANDOFF_HOST.key, hostLabel: STUB_HANDOFF_HOST.label}],
        },
        origins: {[COPY_PATH]: ACME},
        ...change,
    };
}

/** Open a session by its row, as main would: its terminal opens. */
async function openSession(page: Page, label: string): Promise<void> {
    await sessionRow(page, label).first().click();
    await expect(terminalHeader(page)).toBeVisible();
}

/** Everything the renderer typed into a session's terminal, joined. */
function terminalInput(api: FakeApi, sessionId: string): string {
    return api
        .callsTo('sendInput')
        .filter(([id]) => id === sessionId)
        .map(([, data]) => data)
        .join('');
}

/**
 * `projectOverview` as the e2e stub answers it, by the end of the project's
 * path: the GitHub part dated now, without plans while asked without them.
 */
function stubOverviews(api: FakeApi, overviews: Record<string, ProjectOverview>): void {
    api.handle('projectOverview', (projectPath, options) => {
        const found = Object.entries(overviews).find(([end]) => projectPath.endsWith('/' + end));
        if (!found) return {projectPath, remote: false, repository: null, github: null, worktrees: [], running: []};
        const overview = found[1];
        const github = overview.github?.ok
            ? {
                  ...overview.github,
                  fetchedAt: Date.now(),
                  plansPending: options?.plans === false,
                  plans:
                      options?.plans === false
                          ? []
                          : options?.closed
                            ? overview.github.plans
                            : overview.github.plans.filter((plan) => plan.state === 'open'),
                  pullRequests: options?.merged
                      ? overview.github.pullRequests
                      : overview.github.pullRequests.filter((r) => r.pullRequest.state !== 'merged'),
              }
            : overview.github;
        return {...overview, projectPath, github};
    });
}

// ── The connection card ──

test.describe('remote card', () => {
    test('remote card, connecting, then retrying, then failed', async ({page, api}) => {
        /* Given */
        await sessionRow(page, LABEL.remoteApi).click();
        await expect.poll(() => api.callsTo('openTerminal').map(([id]) => id)).toEqual([S.remoteApi]);

        /* When */
        await api.emit('onRemoteStatus', S.remoteApi, {phase: 'connecting', target: TARGET});

        /* Then */
        await expect(page.getByText('Connecting', {exact: true})).toBeVisible();
        await expect(page.getByText(TARGET, {exact: true})).toBeVisible();
        await expect(terminalStatus(page)).toHaveText('Connecting…');
        // A connecting card offers only Stop trying.
        await expect(page.getByRole('button', {name: 'Stop trying'})).toBeVisible();
        await expect(page.getByRole('button', {name: 'Retry now'})).toBeHidden();

        /* When */
        await api.emit('onRemoteStatus', S.remoteApi, {
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

        /* When */
        await api.emit('onRemoteStatus', S.remoteApi, {
            phase: 'failed',
            target: TARGET,
            reason: 'the host rejected the connection',
            attempts: 1,
        });

        /* Then */
        await expect(page.getByText('Could not connect', {exact: true})).toBeVisible();
        await expect(page.getByText('the host rejected the connection', {exact: true})).toBeVisible();
        await expect(page.getByRole('button', {name: 'Retry now'})).toBeVisible();
    });
});

// ── VM hosts ──

test.describe('VM hosts', () => {
    test.use({fixture: fixtureOf(vmProjects())});

    test('Settings lists the registered VM with its agent line and opens it to its controls; a host with an agent is badged VM in the Projects modal and on its page, an agentless one keeps SSH and offers to register its host; and a VM project’s Manage in Settings and its project settings’ This VM open Settings at its VM', async ({
        page,
    }) => {
        /* When */
        await openVmSettings(page);

        /* Then */
        const list = page.getByRole('list', {name: 'Registered VMs'});
        await expect(list.getByRole('listitem')).toHaveCount(1);
        const vm = vmRow(page, VM_KEY);
        await expect(vm.locator('.vm-row-name')).toHaveText(VM_ADDRESS);
        // The fixture's agent is not this build's version, and no link to it is open.
        await expect(vm.locator('.vm-row-line')).toHaveText('Update available · Offline');
        await expect(vmHead(page, VM_KEY)).toHaveAttribute('aria-expanded', 'false');
        await expect(vm.getByRole('button', {name: 'Open setup terminal'})).toHaveCount(0);

        /* When */
        await vmHead(page, VM_KEY).click();

        /* Then */
        await expect(vmHead(page, VM_KEY)).toHaveAttribute('aria-expanded', 'true');
        await expect(vm).toContainText('Agent 0.0.0-e2e runs here; this app has a newer one.');
        await expect(vm.getByRole('button', {name: 'Update agent'})).toBeEnabled();
        await expect(vm.getByRole('button', {name: 'Open setup terminal'})).toBeVisible();
        await expect(vm.getByRole('button', {name: 'Check again'})).toBeVisible();
        await expect(vm.getByRole('button', {name: 'Remove ' + VM_ADDRESS})).toBeVisible();

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
        const vmPage = projectPage(page, REMOTE_LABEL.vm);
        await expect(vmPage.getByRole('heading', {level: 1})).toHaveText(REMOTE_LABEL.vm);
        await expect(vmPage.getByText('VM', {exact: true})).toHaveAttribute(
            'title',
            `Runs on a Switchboard agent on ${VM_ADDRESS}`,
        );
        await expect(manageInSettings(vmPage)).toHaveText(`On ${VM_ADDRESS} · Manage in Settings`);
        await expect(vmPage.getByRole('region', {name: 'Setup'})).toHaveCount(0);
        await expect(vmPage.getByRole('button', {name: 'Install agent'})).toHaveCount(0);
        await expect(vmPage.getByRole('button', {name: 'Register this host as a VM'})).toHaveCount(0);

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
        api,
    }) => {
        /* Given */
        await openProjectPage(page, REMOTE_LABEL.ssh);

        /* When */
        await projectPage(page, REMOTE_LABEL.ssh).getByRole('button', {name: 'Register this host as a VM'}).click();

        /* Then */
        await expect(globalSettingsTitle(page)).toBeVisible();
        expect(api.callsTo('addVmHost')).toEqual([[expect.objectContaining({user: REMOTE.user, host: REMOTE.host})]]);
        const vm = vmRow(page, SSH_KEY);
        await expect(vmHead(page, SSH_KEY)).toHaveAttribute('aria-expanded', 'true');
        await expect(vm.locator('.vm-row-name')).toHaveText(SSH_ADDRESS);
        await expect(vm).toContainText('No agent yet');
        await expect(vm.getByRole('button', {name: 'Install agent'})).toBeEnabled();
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
    test.use({fixture: fixtureOf(vmProjects())});

    test('Add a VM adds a new one, open to Install agent', async ({page, api}) => {
        /* Given */
        await openVmSettings(page);
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
        expect(api.callsTo('addVmHost')).toEqual([[{user: 'dev', host: 'build.local', port: 2222, name: 'Build VM'}]]);
        const key = 'dev@build.local:2222';
        const vm = vmRow(page, key);
        await expect(vm.locator('.vm-row-name')).toHaveText('Build VM');
        await expect(vm.locator('.vm-row-line')).toHaveText('dev@build.local:2222 · No agent yet');
        await expect(vmHead(page, key)).toHaveAttribute('aria-expanded', 'true');
        await expect(vm.getByRole('button', {name: 'Install agent'})).toBeEnabled();
        await expect(page.getByRole('list', {name: 'Registered VMs'}).getByRole('listitem')).toHaveCount(2);
    });

    test.describe('installing', () => {
        const NEW_KEY = 'dev@build.local:22';
        const NEW_PATH = 'ssh://dev@build.local';
        test.use({vmSetup: {vms: [vmEntry('dev', 'build.local')]}});

        test('Install agent streams its progress lines on the VM’s row, then shows its agent and setup', async ({
            page,
            api,
            vm,
        }) => {
            /* Given */
            const lines = ['Checking the host…', 'Copying the agent (0.0.0-e2e)…', 'Starting the service…'];
            vm.agent = {
                ...STUB_AGENT,
                status: {installed: '0.0.0-e2e', current: true, connected: true},
                installLines: lines,
                installLineDelayMs: 150,
            };
            await openVm(page, NEW_KEY);
            const host = vmRow(page, NEW_KEY);
            await expect(host.locator('.vm-row-line')).toHaveText('No agent yet');
            await expect(host.getByRole('button', {name: 'Open setup terminal'})).toHaveCount(0);

            /* When */
            await host.getByRole('button', {name: 'Install agent'}).click();

            /* Then */
            await expect(host.getByRole('button', {name: 'Installing…', exact: true})).toBeDisabled();
            await expect(host.locator('.vm-row-line')).toHaveText('Installing…');
            for (const line of lines) await expect(host).toContainText(line);
            await expect(host.locator('.vm-row-line')).toHaveText('Agent 0.0.0-e2e · Connected');
            await expect(host.getByText('Ready', {exact: true})).toBeVisible();
            await expect(host.getByRole('button', {name: 'Install agent'})).toHaveCount(0);
            await expect(host.getByLabel('Host instructions')).toHaveValue(STUB_AGENT.hostSettings!.instructions);
            expect(api.callsTo('installAgent')).toEqual([[NEW_PATH]]);
        });
    });

    test('a VM’s host settings show what its agent has and save a change to it, Open setup terminal says why it didn’t open, and Rename gives it a name that an empty one takes back to the address', async ({
        page,
        api,
    }) => {
        /* When */
        await openVm(page, VM_KEY);

        /* Then */
        const vm = vmRow(page, VM_KEY);
        const copyConfig = vm.getByRole('checkbox', {name: 'Copy my Claude config to this VM'});
        await expect(vm.getByLabel('Host instructions')).toHaveValue(STUB_AGENT.hostSettings!.instructions);
        await expect(copyConfig).not.toBeChecked();
        await expect(vm.getByLabel('Base folder for copies')).toHaveValue('~/projects');

        /* When */
        await vm.getByLabel('Base folder for copies').fill('~/work');
        await vm.getByLabel('Base folder for copies').press('Enter');

        /* Then */
        await expect.poll(() => api.callsTo('setAgentHostSettings')).toEqual([[VM_HOST_PATH, {baseFolder: '~/work'}]]);
        await expect(vm.getByLabel('Base folder for copies')).toHaveValue('~/work');

        /* When */
        await copyConfig.locator('..').click();

        /* Then */
        await expect(copyConfig).toBeChecked();

        /* When */
        await vm.getByLabel('Host instructions').fill('Use the shared cache.');
        await vm.getByLabel('Base folder for copies').focus();

        /* Then */
        await expect
            .poll(() => api.callsTo('setAgentHostSettings'))
            .toEqual([
                [VM_HOST_PATH, {baseFolder: '~/work'}],
                [VM_HOST_PATH, {copyConfig: true}],
                [VM_HOST_PATH, {instructions: 'Use the shared cache.'}],
            ]);

        /* When */
        await vm.getByRole('button', {name: 'Open setup terminal'}).click();

        /* Then */
        await expect(vm.getByRole('alert')).toHaveText('No setup terminal in the harness');
        expect(api.callsTo('openAgentSetupTerminal')).toEqual([[VM_HOST_PATH]]);

        /* When */
        const name = vm.getByLabel('Rename ' + VM_ADDRESS);
        await expect(name).toHaveValue('');
        await name.fill('Dev VM');
        await name.press('Enter');

        /* Then */
        await expect(vm.locator('.vm-row-name')).toHaveText('Dev VM');
        await expect(vm.locator('.vm-row-address')).toHaveText(VM_ADDRESS + ' · ');
        await expect(vm.getByLabel('Rename Dev VM')).toHaveValue('Dev VM');

        /* When */
        await vm.getByLabel('Rename Dev VM').fill('');
        await vm.getByLabel('Rename Dev VM').press('Enter');

        /* Then */
        await expect(vm.locator('.vm-row-name')).toHaveText(VM_ADDRESS);
        await expect(vm.locator('.vm-row-address')).toHaveCount(0);
        expect(api.callsTo('renameVmHost')).toEqual([
            [VM_KEY, 'Dev VM'],
            [VM_KEY, ''],
        ]);
    });

    test('Remove asks first, keeps the VM when declined, and once confirmed forgets it and its projects', async ({
        page,
        api,
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
        expect(api.callsTo('removeVmHost')).toEqual([]);

        /* When */
        await answerDialogs(page, true);
        await remove.click();

        /* Then */
        await expect(vmRow(page, VM_KEY)).toHaveCount(0);
        await expect(page.getByText('No VM is registered yet.', {exact: true})).toBeVisible();
        expect(api.callsTo('removeVmHost')).toEqual([[VM_KEY]]);

        /* When */
        await openProjects(page);

        /* Then */
        await expect(pickerName(page, REMOTE_LABEL.ssh)).toBeVisible();
        await expect(pickerName(page, REMOTE_LABEL.vm)).toHaveCount(0);
    });
});

// ── Project hand-off ──

test.describe('project hand-off', () => {
    test.use({
        fixture: fixtureOf(handoffProjects()),
        vmSetup: {handoff: STUB_HANDOFF},
    });

    function thisCopy(page: Page): Locator {
        return projectPage(page, REMOTE_LABEL.copy).getByRole('region', {name: 'This copy'});
    }

    test('Hand off to… shows what goes over and the ignored files, hands off the ticked ones with its progress, and opens the copy', async ({
        page,
        api,
        vm,
    }) => {
        /* Given */
        const lines = ['Bundling 2 commits…', 'Cloning on joris@devbox.local…', 'Copying 1 file…'];
        vm.handoff = {...STUB_HANDOFF, lines, lineDelayMs: 150};
        await openProjectPage(page, P.acmeApi);

        /* When */
        await projectPage(page, P.acmeApi).getByRole('button', {name: 'Hand off to…'}).click();

        /* Then */
        const handOff = handOffDialog(page);
        await expect(handOff).toBeVisible();
        await expect(handOff.getByRole('listitem')).toHaveText([
            'Branch main',
            '2 commits not on origin',
            '1 uncommitted change',
        ]);
        const env = handOff.getByRole('checkbox', {name: '.env 312 B', exact: true});
        const envLocal = handOff.getByRole('checkbox', {name: '.env.local 4.1 KB', exact: true});
        await expect(env).toBeChecked();
        await expect(envLocal).not.toBeChecked();
        await expect(handOff).toContainText('Ticked files are copied to the VM as they are.');

        /* When */
        await env.uncheck();
        await envLocal.check();
        await handOff.getByRole('button', {name: 'Hand off', exact: true}).click();

        /* Then */
        await expect(handOff.getByRole('button', {name: 'Handing off…'})).toBeDisabled();
        await expect(envLocal).toBeDisabled();
        for (const line of lines) await expect(handOff).toContainText(line);
        await expect(handOff.getByRole('status')).toHaveText('Handed off');
        await expect(handOff.getByRole('button', {name: 'Close', exact: true})).toBeVisible();
        expect(
            api.callsTo('handOffProject').map(([localPath, hostKey, ticked, choices]) => ({
                localPath,
                hostKey,
                ticked,
                choices: choices ?? {},
            })),
        ).toEqual([{localPath: ACME, hostKey: STUB_HANDOFF_HOST.key, ticked: ['.env.local'], choices: {}}]);

        /* When */
        await handOff.getByRole('button', {name: 'Open the copy'}).click();

        /* Then */
        await expect(handOff).toHaveCount(0);
        await expect(projectPage(page, REMOTE_LABEL.copy)).toBeVisible();
    });

    test('a local project lists its copy under On VMs and the copy’s page links back with Copy of …; Bring back streams its progress and names the branch in the new worktree; Remove copy on a clean copy asks to confirm, and removes it only once confirmed', async ({
        page,
        api,
        vm,
    }) => {
        /* Given */
        const lines = ['Fetching from the copy…', 'Adding a worktree for from-vm…'];
        vm.handoff = linkedCopy({bringBackLines: lines, lineDelayMs: 150});

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
        expect(api.callsTo('bringBackCopy')).toEqual([[COPY_PATH]]);

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
        expect(api.callsTo('removeCopy')).toEqual([]);

        /* When */
        await answerDialogs(page, true);
        await thisCopy(page).getByRole('button', {name: 'Remove copy'}).click();

        /* Then */
        await expect(projectPage(page, P.acmeApi)).toBeVisible();
        expect(api.callsTo('removeCopy')).toEqual([[COPY_PATH]]);
    });
});

// ── Session hand-off ──

test.describe('session hand-off', () => {
    test.use({
        fixture: fixtureOf(handoffProjects()),
        vmSetup: {handoff: STUB_HANDOFF},
    });

    /** Hand off… in the open session's tray, which hovering the bar opens (#343). */
    async function trayHandOffButton(page: Page): Promise<Locator> {
        await terminalHeader(page).getByText(LABEL.loginFix, {exact: true}).hover();
        return page.getByRole('region', {name: 'Session tools'}).getByRole('button', {name: 'Hand off…'});
    }

    test('a local Claude session’s row offers no Hand off to… on hover, and keeps its other buttons', async ({
        page,
    }) => {
        /* Given */
        const session = sessionItem(page, S.loginFix);

        /* When */
        await session.hover();

        /* Then */
        await expect(session.getByRole('button', {name: 'Snooze', exact: true})).toBeVisible();
        await expect(session.getByRole('button', {name: 'Archive', exact: true})).toBeVisible();
        await expect(session.getByRole('button', {name: 'Resume with config', exact: true})).toBeVisible();
        await expect(session.getByRole('button', {name: /^Hand off/})).toHaveCount(0);

        /* When */
        await session.getByRole('button', {name: 'Snooze', exact: true}).click();

        /* Then */
        await expect(page.getByRole('menu', {name: 'Snooze until'})).toBeVisible();
    });

    test('Hand off to… in a local Claude session’s tray opens the hand-off dialog for it', async ({page, api}) => {
        /* Given */
        await openSession(page, LABEL.loginFix);

        /* When */
        await (await trayHandOffButton(page)).click();

        /* Then */
        const handOff = handOffDialog(page);
        await expect(handOff).toBeVisible();
        await expect(handOff).toContainText(LABEL.loginFix);
        expect(api.callsTo('previewSessionHandoff')).toEqual([[S.loginFix]]);
    });

    test('a busy session waits for its turn with Cancel, shows Waiting… and Handing off… on its row, then continues on the VM', async ({
        page,
        api,
        vm,
    }) => {
        /* Given */
        vm.sessionHandoff = {...STUB_SESSION_HANDOFF, phaseDelayMs: 400, waitingMs: 1200};
        await openSession(page, LABEL.loginFix);
        await (await trayHandOffButton(page)).click();
        const handOff = handOffDialog(page);

        /* Then */
        await expect(handOff.getByRole('listitem')).toHaveText([
            'The conversation, resumed on the VM',
            'Branch session-cookie',
            'In worktree session-cookie',
            '2 commits not on origin',
            '1 uncommitted change',
        ]);
        await expect(handOff).toContainText('Claude is mid-turn. The hand-off starts when this turn ends.');

        /* When */
        await handOff.getByRole('checkbox', {name: '.env.local 4.1 KB', exact: true}).check();
        await handOff.getByRole('button', {name: 'Hand off', exact: true}).click();

        /* Then */
        await expect(handOff.getByRole('status')).toHaveText('Waiting for the turn to end…');
        await expect(handOff.getByRole('button', {name: 'Cancel', exact: true})).toBeEnabled();
        await expect(handOff.getByRole('button', {name: 'Waiting…'})).toBeDisabled();
        await expect(handOff).not.toContainText('Claude is mid-turn.');
        expect(api.callsTo('handOffSession')).toEqual([[S.loginFix, STUB_HANDOFF_HOST.key, ['.env', '.env.local']]]);

        /* When */
        await page.keyboard.press('Escape');

        /* Then */
        await expect(handOff).toHaveCount(0);
        const marker = sessionItem(page, S.loginFix).getByText('Waiting…', {exact: true});
        await expect(marker).toHaveAttribute('title', `Hands off to ${STUB_HANDOFF_HOST.label} when this turn ends`);
        await expect(sessionItem(page, S.loginFix).getByText('Handing off…', {exact: true})).toBeVisible();

        /* When */
        await (await trayHandOffButton(page)).click();

        /* Then */
        await expect(handOff).toContainText('Handing off the checkout…');
        await expect(handOff).toContainText('Copying the transcript…');
        await expect(handOff.getByRole('status')).toHaveText('Continues on ' + STUB_HANDOFF_HOST.label);
        await expect(handOff.getByRole('button', {name: 'Close', exact: true})).toBeVisible();
        await expect(sessionItem(page, S.loginFix).getByText(/^(Waiting|Handing off)…$/)).toHaveCount(0);
        expect(api.callsTo('handOffSession')).toHaveLength(1);
    });
});

// ── Bring back ──

test.describe('Bring back', () => {
    test.use({
        fixture: fixtureOf(
            handoffProjects().map((project) =>
                project.projectPath === COPY_PATH ? {...project, sessions: [vmClaudeRow(COPY_PATH)]} : project,
            ),
        ),
    });

    function bringBackDialog(page: Page): Locator {
        return page.getByRole('dialog', {name: 'Bring back to this Mac'});
    }

    test('Bring back… in a VM session’s tray opens its dialog; Update it brings the branch into the worktree here and continues', async ({
        page,
        api,
    }) => {
        /* Given */
        await sessionItem(page, S.vmWeb).click();
        await terminalHeader(page).getByText(LABEL.vmWeb, {exact: true}).hover();

        /* When */
        await page
            .getByRole('region', {name: 'Session tools'})
            .getByRole('button', {name: 'Bring back to this Mac'})
            .click();

        /* Then */
        const bringBack = bringBackDialog(page);
        await expect(bringBack).toContainText(LABEL.vmWeb);
        await expect(bringBack.getByRole('listitem')).toHaveText([
            'The conversation, resumed on this Mac in the same row',
            'The branch session-cookie',
            'Into the worktree at ' + STUB_BRING_BACK_WORKTREE,
            '2 uncommitted changes, still uncommitted here',
        ]);
        const existing = bringBack.getByRole('group', {name: 'Branch exists'});
        await expect(existing).toContainText(
            'session-cookie is in a worktree on this Mac already, with 1 uncommitted file and 2 commits not on the default branch.',
        );
        await expect(bringBack.getByRole('button', {name: 'Bring back', exact: true})).toHaveCount(0);

        /* When */
        await existing.getByRole('button', {name: 'Update it', exact: true}).click();

        /* Then */
        await expect(bringBack).toContainText('Fetching session-cookie from the VM');
        await expect(bringBack.getByRole('status')).toHaveText('Continues on this Mac in ' + STUB_BRING_BACK_WORKTREE);
        expect(api.callsTo('previewSessionBringBack')).toEqual([[S.vmWeb]]);
        expect(api.callsTo('bringBackSession')).toEqual([[S.vmWeb, 'reuse']]);
    });

    test('Delete and recreate… on its row asks once more, naming what goes; Keep it backs out, and confirming recreates it', async ({
        page,
        api,
    }) => {
        /* Given */
        const session = sessionItem(page, S.vmWeb);
        await session.hover();
        await session.getByRole('button', {name: 'Bring back to this Mac'}).click();
        const bringBack = bringBackDialog(page);

        /* When */
        await bringBack.getByRole('button', {name: 'Delete and recreate…'}).click();

        /* Then */
        const confirm = bringBack.getByRole('alertdialog', {name: 'Delete worktree and branch'});
        await expect(confirm).toContainText(
            `Delete the worktree at ${STUB_BRING_BACK_WORKTREE} and its branch, with 1 uncommitted file and 2 commits not on the default branch,`,
        );

        /* When */
        await confirm.getByRole('button', {name: 'Keep it', exact: true}).click();

        /* Then */
        await expect(confirm).toHaveCount(0);
        await expect(bringBack.getByRole('button', {name: 'Update it', exact: true})).toBeVisible();
        expect(api.callsTo('bringBackSession')).toEqual([]);

        /* When */
        await bringBack.getByRole('button', {name: 'Delete and recreate…'}).click();
        await bringBack.getByRole('button', {name: 'Delete and recreate', exact: true}).click();

        /* Then */
        await expect(bringBack).toContainText('Deleting the worktree at ' + STUB_BRING_BACK_WORKTREE);
        await expect(bringBack.getByRole('status')).toHaveText('Continues on this Mac in ' + STUB_BRING_BACK_WORKTREE);
        expect(api.callsTo('bringBackSession')).toEqual([[S.vmWeb, 'replace']]);
    });
});

// ── VM project pages ──

test.describe('VM project pages', () => {
    /** `vmTranscriptProjects` with a shell on the VM host too. */
    function vmShellProjects(): Project[] {
        return vmTranscriptProjects().map((project) =>
            project.projectPath === VM_PATH
                ? {
                      ...project,
                      sessions: [
                          ...project.sessions,
                          row({
                              sessionId: VM_SHELL,
                              projectPath: VM_PATH,
                              summary: 'Remote terminal',
                              created: '2026-06-10T06:00:00.000Z',
                              modified: '2026-06-10T07:00:00.000Z',
                              messageCount: 0,
                              pullRequests: undefined,
                              type: 'remote',
                              remoteKind: 'shell',
                          }),
                      ],
                  }
                : project,
        );
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
    const CAN_OPEN = [S.vmWeb, VM_SHELL, S.remoteApi];
    const SNAPSHOT: SessionWorkSnapshot = {...LOGIN_FIX_WORK, sessionId: S.vmWeb};

    test.use({
        fixture: fixtureOf(vmShellProjects()),
        answers: {
            canOpenSessionWork: (id) => CAN_OPEN.includes(id),
            openSessionWork: (id) => (id === S.vmWeb ? SNAPSHOT : new Promise(() => {})),
        },
    });

    test('a VM session’s row takes its title from the cached transcript; a VM project’s page shows its pull requests, plans and worktrees and the GitHub button, and an agentless remote’s only sessions and the remote note; a VM Claude session’s meta line opens Session work, while a VM shell’s and an agentless remote’s say why not', async ({
        page,
        api,
    }) => {
        /* Given */
        stubOverviews(api, {'apps/web': vmOverview()});

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
        await expect.poll(() => api.callsTo('openRepository')).toEqual([[VM_PATH]]);

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
        expect(api.callsTo('openTerminal').map(([id]) => id)).toEqual([S.vmWeb]);
    });
});

// ── Stage 5 ──

test.describe('stage 5', () => {
    /** Where acme-api's schedules run: on this Mac, or in its copy. */
    function scheduleLocation(runsOn: 'mac' | 'copy', count = 3): ScheduleLocation {
        return {
            localPath: ACME,
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
        test.use({
            fixture: fixtureOf(handoffProjects()),
            vmSetup: {
                handoff: linkedCopy(),
                vmSchedules: schedulesAt(scheduleLocation('mac'), scheduleLocation('copy')),
            },
        });

        test('a local project with a copy and schedules runs them on this Mac, picking the copy moves them there, and the copy’s page offers Run here and Run on the Mac, which moves them back', async ({
            page,
            api,
            vm,
        }) => {
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
            expect(api.callsTo('runSchedulesOn')).toEqual([[ACME, COPY_PATH]]);

            /* When */
            vm.vmSchedules = schedulesAt(scheduleLocation('copy'), scheduleLocation('mac'));
            await page.keyboard.press('Escape');
            await openProjectPage(page, REMOTE_LABEL.copy);

            /* Then */
            const copyPicker = schedulesPicker(page, REMOTE_LABEL.copy);
            await expect(copyPicker.locator('option')).toHaveText(['Run here', 'Run on the Mac']);
            await expect(copyPicker.locator('option:checked')).toHaveText('Run here');
            expect(api.callsTo('schedulesWhere')).toContainEqual([COPY_PATH]);

            /* When */
            await copyPicker.selectOption({label: 'Run on the Mac'});

            /* Then */
            await expect(copyPicker.locator('option:checked')).toHaveText('Run on the Mac');
            expect(api.callsTo('runSchedulesOn')).toEqual([
                [ACME, COPY_PATH],
                [ACME, null],
            ]);
        });
    });

    test.describe('the hand-off’s schedules choice', () => {
        test.use({
            fixture: fixtureOf(handoffProjects()),
            vmSetup: {handoff: STUB_HANDOFF, vmSchedules: schedulesAt(scheduleLocation('mac', 2))},
        });

        test('with schedules the dialog offers to run them on the VM, ticked, and the hand-off carries that choice', async ({
            page,
            api,
        }) => {
            /* Given */
            await openProjectPage(page, P.acmeApi);
            await projectPage(page, P.acmeApi).getByRole('button', {name: 'Hand off to…'}).click();
            const handOff = handOffDialog(page);
            await expect(handOff.getByRole('checkbox', {name: SCHEDULES_CHOICE, exact: true})).toBeChecked();
            await expect(handOff).toContainText('2 schedules. Ticked, they stop running on this Mac.');

            /* When */
            await handOff.getByRole('button', {name: 'Hand off', exact: true}).click();

            /* Then */
            await expect(handOff.getByRole('status')).toHaveText('Handed off');
            expect(api.callsTo('handOffProject').map(([, , , choices]) => choices)).toEqual([{schedulesOnVm: true}]);
        });
    });

    test.describe('tasks on VM projects', () => {
        test.use({
            fixture: fixtureOf(vmProjects()),
            settings: {global: {appearance: 'light', weatherEnabled: false, blaakTasksUrl: 'http://127.0.0.1:1/mcp'}},
            answers: {
                blaakTasksSetUp: true,
                projectTasks: (projectPath) => (projectPath === VM_PATH ? [TASK] : []),
                // What main makes of the stand-in BlaakTasks' answer (e2e/support/blaak-tasks.ts).
                getTask: (id) => ({
                    kind: 'ok',
                    value: parseTaskDetail({
                        id,
                        title: TITLE,
                        status: 'In progress',
                        today: true,
                        pullRequests: [],
                        brief: '',
                        progress: [],
                        url: 'https://www.notion.so/x',
                    })!,
                }),
            },
        });

        test('a VM project’s page lists the task linked to it', async ({page, api}) => {
            /* Given */
            stubOverviews(api, {'apps/web': {...acmeOverview(), projectPath: VM_PATH, worktrees: []}});

            /* When */
            await openProjectPage(page, REMOTE_LABEL.vm);

            /* Then */
            const tasks = projectPage(page, REMOTE_LABEL.vm).getByRole('region', {name: 'Tasks'});
            await expect(tasks.locator(`[data-task-id="${TASK}"]`)).toContainText(TITLE);
            expect(api.callsTo('projectTasks')).toContainEqual([VM_PATH]);
        });
    });

    test.describe('files dropped on a VM terminal', () => {
        test.use({fixture: fixtureOf(vmTranscriptProjects())});

        /** What the renderer is told the dropped files' paths are: `getPathForFile`'s, in the fake api. */
        const FILES = ["/dropped/Bob's notes.txt", '/dropped/plain.txt'];
        const VM_DROPS = ["/home/joris/.switchboard/drops/Bob's notes.txt", '/home/joris/.switchboard/drops/plain.txt'];

        /** Drop two files, one with a quote in its name, on the session's terminal, as Finder does. */
        async function dropOn(page: Page, sessionId: string): Promise<void> {
            await expect.poll(() => hasTerminal(page, sessionId)).toBe(true);
            const point = await cellPoint(page, sessionId, 10, 5);
            await page.evaluate(
                ([x, y]) => {
                    const target = document.elementFromPoint(x, y)!;
                    for (const type of ['dragenter', 'drop']) {
                        const transfer = new DataTransfer();
                        if (type === 'drop') {
                            for (const name of ["Bob's notes.txt", 'plain.txt'])
                                transfer.items.add(new File(['x'], name));
                        }
                        target.dispatchEvent(
                            new DragEvent(type, {dataTransfer: transfer, bubbles: true, cancelable: true}),
                        );
                    }
                },
                [point.x, point.y],
            );
        }

        test('a VM session uploads the dropped files, says so while it does, and types their paths on the VM, while a local session types their own paths and uploads nothing', async ({
            page,
            api,
            vm,
        }) => {
            /* Given */
            vm.droppedFiles = {result: {ok: true, paths: VM_DROPS}, delayMs: 500};
            await sessionItem(page, S.vmWeb).click();

            /* When */
            await dropOn(page, S.vmWeb);

            /* Then */
            const toast = page.getByTestId('drop-upload');
            await expect(toast).toHaveText('Uploading 2 files to the VM…');
            await expect(toast).toHaveCount(0);
            await expect.poll(() => terminalInput(api, S.vmWeb)).toBe(VM_DROPS.map(posixQuote).join(' '));
            expect(api.callsTo('uploadDroppedFiles')).toEqual([[S.vmWeb, FILES]]);

            /* When */
            await sessionRow(page, LABEL.loginFix).first().click();
            await dropOn(page, S.loginFix);

            /* Then */
            await expect.poll(() => terminalInput(api, S.loginFix)).toBe(FILES.map(posixQuote).join(' '));
            expect(api.callsTo('uploadDroppedFiles')).toHaveLength(1);
            await expect(toast).toHaveCount(0);
        });
    });
});

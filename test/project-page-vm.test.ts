/**
 * The project page on a remote project (#276, #307): what the page shows on
 * a VM project (stage 4: what a local one does; stage 5: Tasks too) and an
 * agentless one, and how it points to its VM in Settings, or offers to
 * register the host as one. The VM's controls are tested in
 * `vm-controls.test.ts`.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    githubPart,
    isVmRepositoryIn,
    opensGitHub,
    projectLinkTitle,
    REMOTE_NOTE,
    showsTasks,
    showsWorktrees,
} from '../src/renderer/ui/project-page/page-state';
import {hostLinkOf} from '../src/renderer/ui/vms/vm-hosts';
import {initialAgentHostState} from '../src/renderer/state/agent-host-slice';
import {groupOverview} from '../src/domain/plan/project-overview';
import type {ProjectIssue, ProjectOverview, ProjectPullRequest} from '../src/domain/project/overview';
import type {VmHostView} from '../src/application/services/vm-registry';

const VM = 'ssh://me@vm/app';
const SSH = 'ssh://me@box/app';

/** A VM project's full answer, as main reads it on the VM. */
function overview(fields: Partial<ProjectOverview> = {}): ProjectOverview {
    const groups = groupOverview<ProjectIssue, ProjectPullRequest>({
        repository: 'me/app',
        plans: [],
        issues: [],
        pullRequests: [],
        sessions: {owners: {}, running: new Set()},
    });
    return {
        projectPath: VM,
        remote: false,
        repository: 'me/app',
        github: {ok: true, fetchedAt: 1_000, stale: false, plansPending: false, mergeQueue: null, ...groups},
        worktrees: [
            {
                path: '/home/me/app',
                branch: 'main',
                main: true,
                locked: false,
                changedFiles: 0,
                ahead: 0,
                merged: false,
                lastCommitAt: null,
                running: [],
            },
        ],
        running: [],
        ...fields,
    };
}

// ── Page state ──

test('a VM project takes a local project’s kinds, even when its overview still says remote', () => {
    /* Given */
    const repo = overview({remote: true});
    const noGitHub = overview({remote: true, repository: null, github: null});

    /* When */
    const loading = githubPart(null, VM, true);
    const ok = githubPart(repo, VM, true);
    const none = githubPart(noGitHub, VM, true);

    /* Then */
    assert.deepEqual(loading, {kind: 'loading'});
    assert.deepEqual(ok, {kind: 'ok', stale: false, fetchedAt: 1_000});
    assert.deepEqual(none, {kind: 'none'});
});

test('a VM project shows its worktrees, an agentless remote still none, a local project as before', () => {
    /* Given */
    const vm = overview();
    const local = overview({projectPath: '/repo'});

    /* When */
    const shown = [
        showsWorktrees(vm, VM, true),
        showsWorktrees(null, VM, true),
        showsWorktrees(null, SSH),
        showsWorktrees(local, '/repo'),
    ];

    /* Then */
    assert.deepEqual(shown, [true, true, false, true]);
});

test('an agentless remote stays remote, naming its host', () => {
    /* When */
    const part = githubPart(overview({projectPath: SSH, remote: true}), SSH);

    /* Then */
    assert.deepEqual(part, {kind: 'remote', host: 'me@box:22'});
});

test('the note under an agentless remote says plans and worktrees aren’t read over ssh', () => {
    /* Then */
    assert.equal(REMOTE_NOTE, 'Plans and worktrees aren’t read over ssh.');
});

test('Tasks show on a VM project as on a local one, and stay off on an agentless remote', () => {
    /* Given */
    const projects: [string, boolean][] = [
        [VM, true],
        [SSH, false],
        ['/repo', false],
    ];

    /* When */
    const shown = projects.map(([path, vm]) => showsTasks(path, vm));

    /* Then */
    assert.deepEqual(shown, [true, false, true]);
});

// ── GitHub ──

test('⌘-click and the GitHub button open GitHub for a VM project and a local one, not an agentless remote', () => {
    /* When */
    const opens = [opensGitHub(VM, true), opensGitHub('/repo', false), opensGitHub(SSH, false)];

    /* Then */
    assert.deepEqual(opens, [true, true, false]);
});

test('a project name’s tooltip offers ⌘-click on a VM project, not on an agentless remote', () => {
    /* When */
    const vm = projectLinkTitle(VM, true);
    const ssh = projectLinkTitle(SSH);
    const local = projectLinkTitle('/repo');

    /* Then */
    assert.equal(vm, 'Open me@vm/app\n⌘-click opens GitHub');
    assert.equal(ssh, 'Open me@box/app');
    assert.equal(local, 'Open repo\n⌘-click opens GitHub');
});

test('a worktree of a VM project counts as on the VM', () => {
    /* Given */
    const agentHost = {...initialAgentHostState, vmProjects: {[VM]: true as const}};

    /* When */
    const verdicts = [
        isVmRepositoryIn(agentHost, VM),
        isVmRepositoryIn(agentHost, VM + '/.claude/worktrees/fix'),
        isVmRepositoryIn(agentHost, SSH),
    ];

    /* Then */
    assert.deepEqual(verdicts, [true, true, false]);
});

// ── Its VM ──

/** A registered VM, as main lists it. */
function vmHost(fields: Partial<VmHostView> = {}): VmHostView {
    return {
        key: 'me@vm:22',
        user: 'me',
        host: 'vm',
        port: 22,
        label: 'Dev VM',
        agent: '2.11.9',
        current: true,
        connected: true,
        projects: [VM],
        ...fields,
    };
}

test('a VM project links to its VM in Settings by the VM’s name, with no Register', () => {
    /* When */
    const link = hostLinkOf(VM, true, [vmHost()]);

    /* Then */
    assert.deepEqual(link, {kind: 'vm', key: 'me@vm:22', label: 'Dev VM'});
});

test('a VM project the list hasn’t named yet links to its VM by its address', () => {
    /* When */
    const unread = hostLinkOf(VM, true, null);
    const onPort = hostLinkOf('ssh://me@vm:2222/app', true, []);

    /* Then */
    assert.deepEqual(unread, {kind: 'vm', key: 'me@vm:22', label: 'me@vm'});
    assert.deepEqual(onPort, {kind: 'vm', key: 'me@vm:2222', label: 'me@vm:2222'});
});

test('an agentless remote on a host that isn’t registered offers Register, with its user, host and port', () => {
    /* When */
    const link = hostLinkOf('ssh://me@box:2222/app', false, [vmHost()]);

    /* Then */
    assert.deepEqual(link, {kind: 'register', user: 'me', host: 'box', port: 2222});
});

test('an agentless remote on a registered host links to that VM instead of offering Register', () => {
    /* Given */
    const noAgentYet = vmHost({key: 'me@box:22', host: 'box', label: 'me@box', agent: null, current: false});

    /* When */
    const link = hostLinkOf(SSH, false, [noAgentYet]);

    /* Then */
    assert.deepEqual(link, {kind: 'vm', key: 'me@box:22', label: 'me@box'});
});

test('a local project has no host to link to', () => {
    /* When */
    const link = hostLinkOf('/repo', false, [vmHost()]);

    /* Then */
    assert.equal(link, null);
});

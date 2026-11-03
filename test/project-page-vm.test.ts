/**
 * The project page on a remote project (#276): what the page shows on a VM
 * project (stage 4: what a local one does; stage 5: Tasks too) and an agentless one, the Install agent card's states, and the Setup section's checks.
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
import {
    installView,
    offersUpdate,
    setupDone,
    toolLine,
    toolLines,
} from '../src/renderer/ui/project-page/agent-host-view';
import {initialAgentHostState, NO_HOST} from '../src/renderer/state/agent-host-slice';
import {groupOverview} from '../src/domain/plan/project-overview';
import type {ProjectIssue, ProjectOverview, ProjectPullRequest} from '../src/domain/project/overview';

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
        github: {ok: true, fetchedAt: 1_000, stale: false, plansPending: false, ...groups},
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

// ── Install agent ──

test('before an install the button says Install agent', () => {
    /* When */
    const view = installView({phase: 'idle'});

    /* Then */
    assert.deepEqual(view, {label: 'Install agent', disabled: false, lines: [], error: null});
});

test('while it installs the button waits and the lines show', () => {
    /* When */
    const view = installView({phase: 'running', lines: ['Checking systemd']});

    /* Then */
    assert.deepEqual(view, {label: 'Installing…', disabled: true, lines: ['Checking systemd'], error: null});
});

test('a failed install shows why, and the button says Retry', () => {
    /* When */
    const view = installView({phase: 'failed', lines: ['Checking systemd'], error: 'No systemd.'});

    /* Then */
    assert.deepEqual(view, {label: 'Retry', disabled: false, lines: ['Checking systemd'], error: 'No systemd.'});
});

test('an update in progress says Updating…', () => {
    /* When */
    const view = installView({phase: 'running', lines: []}, 'Update agent');

    /* Then */
    assert.equal(view.label, 'Updating…');
});

test('Update agent is offered only while the agent is not the app’s version', () => {
    /* When */
    const old = offersUpdate({...NO_HOST, status: {installed: '2.11.0', current: false, connected: true}});
    const current = offersUpdate({...NO_HOST, status: {installed: '2.12.0', current: true, connected: true}});
    const unknown = offersUpdate(NO_HOST);

    /* Then */
    assert.deepEqual([old, current, unknown], [true, false, false]);
});

// ── Setup checks ──

test('a signed-in tool is ready, with its version', () => {
    /* When */
    const line = toolLine({tool: 'gh', installed: true, version: '2.60.1', loggedIn: true});

    /* Then */
    assert.deepEqual(line, {tool: 'gh', state: 'ready', text: 'Installed, 2.60.1 · signed in'});
});

test('an installed tool that is signed out says so', () => {
    /* When */
    const line = toolLine({tool: 'claude', installed: true, version: '2.1.220', loggedIn: false});

    /* Then */
    assert.deepEqual(line, {tool: 'claude', state: 'signed-out', text: 'Installed, 2.1.220 · not signed in'});
});

test('git has no login, so it is ready once installed', () => {
    /* When */
    const line = toolLine({tool: 'git', installed: true, version: '2.43.0'});

    /* Then */
    assert.deepEqual(line, {tool: 'git', state: 'ready', text: 'Installed, 2.43.0'});
});

test('the checks list every tool in setup’s order, a missing answer as not installed', () => {
    /* When */
    const lines = toolLines([{tool: 'git', installed: true}]);

    /* Then */
    assert.deepEqual(lines, [
        {tool: 'claude', state: 'missing', text: 'Not installed'},
        {tool: 'gh', state: 'missing', text: 'Not installed'},
        {tool: 'git', state: 'ready', text: 'Installed'},
    ]);
});

test('setup is done only when every tool is ready', () => {
    /* Given */
    const ready = [
        {tool: 'claude' as const, installed: true, loggedIn: true},
        {tool: 'gh' as const, installed: true, loggedIn: true},
        {tool: 'git' as const, installed: true},
    ];

    /* When */
    const done = setupDone(ready);
    const signedOut = setupDone([...ready.slice(0, 1), {tool: 'gh', installed: true, loggedIn: false}, ready[2]]);

    /* Then */
    assert.equal(done, true);
    assert.equal(signedOut, false);
});

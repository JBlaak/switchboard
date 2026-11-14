import {test} from 'node:test';
import assert from 'node:assert/strict';

import {agentlessRemoteGuard, isAgentlessRemote, type RemoteHostRecord} from '../src/domain/project/agentless-remote';
import {PlanService} from '../src/application/services/plan-service';
import {ProjectOverviewService} from '../src/application/services/project-overview-service';
import {SessionWorkService} from '../src/application/services/session-work-service';
import {IssueSessionService} from '../src/application/services/issue-session-service';
import {WorktreeCleanupService} from '../src/application/services/worktree-cleanup-service';
import {registerHostHandlers} from '../src/main/ipc/host-handlers';
import {INVOKE} from '../src/ipc/channels';
import type {Container} from '../src/main/composition-root';
import type {InvokeHandler, IpcRegistrar} from '../src/main/ipc/support/registrar';
import type {GitWorkspace, GitWorktrees} from '../src/application/ports/git-workspace';
import type {GitHubCli} from '../src/application/ports/github-cli';
import type {Logger} from '../src/application/ports/logger';
import type {Plan, PlanIssue} from '../src/domain/plan/model';
import type {WorktreeSummary} from '../src/domain/project/overview';

const AGENT = {version: '2.12.0', installedAt: '2026-11-01T00:00:00Z'};
const REMOTES: RemoteHostRecord[] = [
    {user: 'dev', host: 'vm.local', port: 2222, agent: AGENT},
    {user: 'me', host: 'box', port: 22},
];
const agentless = agentlessRemoteGuard(() => REMOTES);

/** A VM project, a worktree under it as git names it, and an agentless remote project. */
const VM_PROJECT = 'ssh://dev@vm.local:2222/~/projects/site';
const VM_ROOT = 'ssh://dev@vm.local:2222//home/dev/projects/site';
const VM_WORKTREE = VM_ROOT + '/.claude/worktrees/12-billing';
/** That worktree as a session started in it under the `~` project names it. */
const VM_PROJECT_WORKTREE = VM_PROJECT + '/.claude/worktrees/12-billing';
const BOX_PROJECT = 'ssh://me@box/srv/app';
const ORIGIN = 'git@github.com:acme/site.git';
const REPO = 'acme/site';

const silent: Logger = {debug() {}, info() {}, warn() {}, error() {}};
const clock = {now: () => 1_000_000};

/** A git that answers for the VM project's paths only, recording what it was asked. */
function vmGit(calls: string[]) {
    return {
        async worktreeRoot(cwd: string) {
            calls.push('worktreeRoot ' + cwd);
            if (cwd === VM_PROJECT || cwd === VM_ROOT) return VM_ROOT;
            return cwd === VM_WORKTREE || cwd === VM_PROJECT_WORKTREE ? VM_WORKTREE : null;
        },
        async mainCheckout(cwd: string) {
            calls.push('mainCheckout ' + cwd);
            return cwd.startsWith(VM_ROOT) || cwd === VM_PROJECT ? VM_ROOT : null;
        },
        async worktrees(root: string): Promise<WorktreeSummary[]> {
            calls.push('worktrees ' + root);
            return [];
        },
        async defaultBranch(root: string) {
            calls.push('defaultBranch ' + root);
            return 'main';
        },
    };
}

const remotes = {originUrl: async (path: string) => (path.startsWith('ssh://dev@') ? ORIGIN : null)};

// ── The predicate ──

test('only a remote on a host without an agent is agentless', () => {
    /* When */
    const answers = [VM_PROJECT, VM_WORKTREE, BOX_PROJECT, '/Users/me/dev/web', 'ssh://dev@vm.local/x'].map((path) =>
        isAgentlessRemote(path, REMOTES),
    );

    /* Then */
    // The last is the same user and host on port 22: another host as far as the agent goes.
    assert.deepEqual(answers, [false, false, true, false, true]);
});

// ── Plans ──

function plans(calls: string[]) {
    const github: Pick<GitHubCli, 'plan' | 'plansIn' | 'plansOf' | 'closingIssues'> = {
        plan: async () => null,
        plansIn: async (repository) => {
            calls.push('plansIn ' + repository);
            return [];
        },
        plansOf: async () => [],
        closingIssues: async () => [],
    };
    return new PlanService({
        locate: () => null,
        transcripts: {locations: () => [], readSession: () => null},
        git: vmGit(calls),
        remotes,
        github,
        clock,
        agentlessRemote: agentless,
    });
}

test('a VM project’s plans are read through its git and gh', async () => {
    /* Given */
    const calls: string[] = [];

    /* When */
    const answer = await plans(calls).projectPlans(VM_PROJECT, {closed: false});

    /* Then */
    assert.deepEqual(answer, []);
    assert.deepEqual(calls, ['worktreeRoot ' + VM_PROJECT, 'plansIn ' + REPO]);
});

test('an agentless remote project still has no plans, and nothing is asked', async () => {
    /* Given */
    const calls: string[] = [];

    /* When */
    const answer = await plans(calls).projectPlans(BOX_PROJECT, {closed: false});

    /* Then */
    assert.equal(answer, null);
    assert.deepEqual(calls, []);
});

// ── The project page ──

function overview(calls: string[]) {
    return new ProjectOverviewService({
        plans: {projectPlans: async () => [], plan: async () => null},
        owners: {issueSessions: async () => ({})},
        running: () => [{sessionId: 's1', projectPath: VM_PROJECT}],
        git: vmGit(calls),
        worktreeWrites: {
            ...vmGit(calls),
            removeWorktree: async () => ({ok: true}),
            pruneWorktrees: async () => ({ok: true}),
        },
        remotes,
        github: {
            available: async () => 'ok',
            issuesIn: async () => [],
            pullRequestsIn: async () => [],
            ciRunDurations: async () => [],
        },
        clock,
        agentlessRemote: agentless,
    });
}

test('a VM project’s page is read like a local one, and still says it is remote', async () => {
    /* Given */
    const calls: string[] = [];

    /* When */
    const answer = await overview(calls).overview(VM_PROJECT);

    /* Then */
    assert.equal(answer.remote, true);
    assert.equal(answer.repository, REPO);
    assert.equal(answer.github?.ok, true);
    assert.deepEqual(answer.running, ['s1']);
    assert.deepEqual(calls, ['worktreeRoot ' + VM_PROJECT, 'worktrees ' + VM_ROOT]);
});

test('an agentless remote project’s page answers its running sessions only', async () => {
    /* Given */
    const calls: string[] = [];

    /* When */
    const answer = await overview(calls).overview(BOX_PROJECT);

    /* Then */
    assert.deepEqual(answer, {
        projectPath: BOX_PROJECT,
        remote: true,
        repository: null,
        github: null,
        worktrees: [],
        running: [],
    });
    assert.deepEqual(calls, []);
});

// ── Session work ──

function sessionWork(projectPath: string, calls: string[]) {
    return new SessionWorkService({
        locate: () => ({folder: null, projectPath}),
        transcripts: {locations: () => [], issueMentions: () => [], readSession: () => null},
        git: vmGit(calls) as unknown as GitWorkspace,
        github: {} as unknown as ConstructorParameters<typeof SessionWorkService>[0]['github'],
        remotes,
        renderer: {sessionWorkSnapshot() {}},
        clock,
        timers: {
            setTimeout: () => null,
            clearTimeout() {},
            setInterval: () => null,
            clearInterval() {},
        } as unknown as ConstructorParameters<typeof SessionWorkService>[0]['timers'],
        log: silent,
        agentlessRemote: agentless,
    });
}

test('a VM session’s work page can open; an agentless remote session’s still cannot', async () => {
    /* Given */
    const calls: string[] = [];

    /* When */
    const vm = await sessionWork(VM_PROJECT, calls).canOpen('s1');
    const box = await sessionWork(BOX_PROJECT, calls).canOpen('s2');

    /* Then */
    assert.equal(vm, true);
    assert.equal(box, false);
    assert.deepEqual(calls, ['worktreeRoot ' + VM_PROJECT]);
});

// ── Issue sessions ──

function issueSessions(calls: string[]) {
    const git = {
        ...vmGit(calls),
        currentBranch: async () => null,
        defaultBranch: async () => 'main',
        branchExists: async () => false,
        commitSha: async (_root: string, ref: string) => (ref === 'origin/main' ? 'abc123' : null),
        fetchBranch: async () => ({ok: true}),
        addWorktree: async (root: string, path: string) => {
            calls.push(`addWorktree ${root} ${path}`);
            return {ok: true};
        },
    } as unknown as Pick<GitWorkspace, 'currentBranch' | 'defaultBranch' | 'branchExists' | 'commitSha' | 'worktrees'> &
        GitWorktrees;
    return new IssueSessionService({
        sessions: () => [
            {
                sessionId: 'vm',
                projectPath: VM_PROJECT,
                folder: 'vm:dev@vm.local:2222:-x',
                activeAt: 2,
                pullRequests: [],
            },
            {sessionId: 'box', projectPath: BOX_PROJECT, folder: '-box', activeAt: 3, pullRequests: []},
        ],
        // Answered later, as the routing store answers a VM folder.
        transcripts: {
            locations: async (folder) => {
                calls.push('locations ' + folder);
                return [{cwd: VM_WORKTREE, branch: '12-billing', fromSubagent: false}];
            },
        },
        git,
        remotes: {originUrl: async (path) => (path.startsWith('ssh://') ? ORIGIN : null)},
        github: {available: async () => 'ok', closingIssues: async () => []},
        clock,
        log: silent,
        agentlessRemote: agentless,
    });
}

test('a VM session owns the issue its branch is named after; an agentless remote one owns none', async () => {
    /* Given */
    const calls: string[] = [];

    /* When */
    const owners = await issueSessions(calls).issueSessions(REPO);

    /* Then */
    assert.deepEqual(owners, {'acme/site#12': 'vm'});
    assert.deepEqual(calls, ['locations vm:dev@vm.local:2222:-x']);
});

function issue(number: number): PlanIssue {
    return {
        repository: REPO,
        number,
        title: 'Billing',
        state: 'open',
        closedAs: null,
        updatedAt: '',
        blockedBy: [],
        pullRequests: [],
        summary: '',
        acceptance: [],
    };
}

test('a session on an issue may start in a VM project, not in an agentless remote one', async () => {
    /* Given */
    const calls: string[] = [];
    const service = issueSessions(calls);
    const plan: Plan = {repository: REPO, number: 1, title: 'Plan', parent: null, issues: [issue(12)], outside: []};
    const request = {issue: {repository: REPO, number: 12}, plan};

    /* When */
    const box = await service.prepareIssueWorktree({projectPath: BOX_PROJECT, ...request});
    const vm = await service.prepareIssueWorktree({projectPath: VM_PROJECT, ...request});

    /* Then */
    assert.deepEqual(box, {ok: false, reason: 'A session on an issue can only start in a local project or on a VM'});
    assert.ok(vm.ok);
    assert.ok(vm.worktreePath.startsWith(VM_ROOT + '/.claude/worktrees/'));
    assert.ok(calls.includes(`addWorktree ${VM_ROOT} ${vm.worktreePath}`));
});

// ── Worktree cleanup ──

function cleanup(projectPath: string, calls: string[], otherPaths: string[] = [], removed: string[] = []) {
    const git = vmGit(calls);
    return new WorktreeCleanupService({
        enabled: () => true,
        locate: () => ({folder: 'vm:dev@vm.local:2222:-x', projectPath}),
        transcripts: {locations: async () => [{cwd: VM_WORKTREE, branch: '12-billing', fromSubagent: false}]},
        git: {
            ...git,
            worktrees: async (root) => {
                calls.push('worktrees ' + root);
                return [
                    {
                        path: VM_ROOT,
                        branch: 'main',
                        main: true,
                        locked: false,
                        changedFiles: 0,
                        ahead: 0,
                        merged: false,
                        lastCommitAt: null,
                    },
                    {
                        path: VM_WORKTREE,
                        branch: '12-billing',
                        main: false,
                        locked: false,
                        changedFiles: 0,
                        ahead: 0,
                        merged: false,
                        lastCommitAt: null,
                    },
                ];
            },
            removeWorktree: async (_root, path) => {
                calls.push('remove ' + path);
                return {ok: true};
            },
        },
        otherSessionPaths: () => otherPaths,
        log: silent,
        agentlessRemote: agentless,
        removed: (worktree) => removed.push(worktree),
    });
}

test('archiving a VM session removes its worktree on the VM; an agentless remote one is left alone', async () => {
    /* Given */
    const vmCalls: string[] = [];
    const boxCalls: string[] = [];

    /* When */
    await cleanup(VM_PROJECT, vmCalls).afterArchive('s1');
    await cleanup(BOX_PROJECT, boxCalls).afterArchive('s2');

    /* Then */
    assert.ok(vmCalls.includes('remove ' + VM_WORKTREE));
    assert.deepEqual(boxCalls, []);
});

test('a removed VM worktree is reported, so its project record can go with it', async () => {
    /* Given */
    const removed: string[] = [];

    /* When */
    await cleanup(VM_PROJECT, [], [], removed).afterArchive('s1');

    /* Then */
    assert.deepEqual(removed, [VM_WORKTREE]);
});

test('a VM worktree another session works in, under its other name, is kept', async () => {
    /* Given */
    const calls: string[] = [];
    // The other session's directory as its project names it: `~`, not git's absolute path.
    const service = cleanup(VM_PROJECT, calls, [VM_PROJECT_WORKTREE]);

    /* When */
    await service.afterArchive('s1');

    /* Then */
    assert.ok(calls.includes('worktreeRoot ' + VM_PROJECT_WORKTREE));
    assert.ok(!calls.some((call) => call.startsWith('remove ')));
});

// ── Open repository ──

function openRepository(remotesNow: RemoteHostRecord[]) {
    const handlers = new Map<string, InvokeHandler>();
    const opened: string[] = [];
    const ipc: IpcRegistrar = {handle: (channel, handler) => handlers.set(channel, handler), on() {}};
    const app = {
        settings: {vmHosts: () => remotesNow},
        git: remotes,
        system: {openExternal: async (url: string) => void opened.push(url)},
    } as unknown as Container;
    registerHostHandlers(ipc, app);
    const handler = handlers.get(INVOKE.openRepository) as (path: string) => Promise<boolean>;
    return {open: handler, opened};
}

test('Open repository opens a VM project’s GitHub page; an agentless remote’s still does nothing', async () => {
    /* Given */
    const {open, opened} = openRepository(REMOTES);

    /* When */
    const vm = await open(VM_PROJECT);
    const box = await open('ssh://dev@box2/x');

    /* Then */
    assert.equal(vm, true);
    assert.equal(box, false);
    assert.deepEqual(opened, ['https://github.com/acme/site']);
});

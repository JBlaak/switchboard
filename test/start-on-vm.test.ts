import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    startIssueSessionWith,
    type StartIssueSessionSteps,
} from '../src/renderer/ui/session-work/plan/start-issue-session';
import {startLevelWith} from '../src/renderer/ui/session-work/plan/start-level';
import {startTaskSessionWith, type StartTaskSessionSteps} from '../src/renderer/ui/tasks/start-task-session';
import {handOffQuestion, type VmStartSteps} from '../src/renderer/ui/session-handoff/start-on-vm';
import type {SessionOptions} from '../src/domain/launch/session-options';
import type {HandoffHost, StartHandoffResult} from '../src/application/services/project-handoff';
import type {IssueKey} from '../src/domain/plan/model';
import {key, plan} from './support/plans';

/**
 * A start handed off to a VM before it began ("Do you want to hand this off
 * to…?"): the worktree is made here as always, goes to the VM, and the
 * session starts in its copy there. Nothing is launched on this Mac.
 */

const VM: HandoffHost = {key: 'dev@vm.local:22', label: 'dev@vm.local'};
const PROJECT = '/dev/app';
const PROJECT_COPY = 'ssh://dev@vm.local/~/projects/app';
const worktreeOf = (n: number) => `${PROJECT}/.claude/worktrees/${n}-issue`;
const copyOf = (n: number) => `${PROJECT_COPY}/.claude/worktrees/${n}-issue`;

interface Recorded {
    order: string[];
    handOffs: {localPath: string; hostKey: string; worktrees: string[]; project: boolean}[];
    vmLaunches: {copyPath: string; options: SessionOptions; show: boolean}[];
    localLaunches: string[];
    defaultsAskedFor: string[];
}

/** The VM steps: each worktree goes over unless it is in `refused`; `answer` replaces the whole answer. */
function vmSteps(
    rec: Recorded,
    {refused = [] as string[], answer = null as StartHandoffResult | null, projectCopy = PROJECT_COPY} = {},
): VmStartSteps {
    return {
        handOff: async (localPath, hostKey, worktrees, {project}, onProgress) => {
            rec.order.push('hand off');
            onProgress?.('Connecting to dev@vm.local');
            onProgress?.('Handing app off to dev@vm.local');
            rec.handOffs.push({localPath, hostKey, worktrees, project});
            if (answer) return answer;
            return {
                ok: true,
                projectCopy: project ? projectCopy : null,
                worktrees: worktrees.map((checkout) =>
                    refused.includes(checkout)
                        ? {checkout, ok: false as const, error: 'the patch did not apply'}
                        : {checkout, ok: true as const, copyPath: checkout.replace(PROJECT, PROJECT_COPY)},
                ),
            };
        },
        launch: async (copyPath, options, how) => {
            rec.order.push('launch on vm');
            rec.vmLaunches.push({copyPath, options, show: how.show});
            return {ok: true, sessionId: 'vm-session'};
        },
    };
}

function recorder(): Recorded {
    return {order: [], handOffs: [], vmLaunches: [], localLaunches: [], defaultsAskedFor: []};
}

function issueSteps(rec: Recorded, vm: VmStartSteps | undefined, failing: number[] = []): StartIssueSessionSteps {
    return {
        prepare: async ({issue}) => {
            rec.order.push('prepare ' + issue.number);
            if (failing.includes(issue.number)) return {ok: false, reason: 'Branch exists'};
            return {
                ok: true,
                worktreePath: worktreeOf(issue.number),
                branch: issue.number + '-issue',
                prompt: 'Work on #' + issue.number + '.',
            };
        },
        defaultOptions: async (path) => {
            rec.defaultsAskedFor.push(path);
            return {permissionMode: 'auto', worktree: true, worktreeName: 'x', addDirs: 'docs'};
        },
        launch: async (path) => {
            rec.localLaunches.push(path);
            return {ok: true, sessionId: 'local-session'};
        },
        ...(vm ? {vm} : {}),
    };
}

// ── An issue's start ──

test('an issue start handed off sends its worktree to the VM and starts the session in its copy there', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec));

    /* When */
    const result = await startIssueSessionWith(steps, {
        projectPath: PROJECT,
        issue: key(7),
        plan: plan([]),
        show: false,
        vm: VM,
    });

    /* Then */
    assert.deepEqual(result, {ok: true, sessionId: 'vm-session'});
    assert.deepEqual(rec.order, ['prepare 7', 'hand off', 'launch on vm']);
    assert.deepEqual(rec.handOffs, [{localPath: PROJECT, hostKey: VM.key, worktrees: [worktreeOf(7)], project: false}]);
    assert.deepEqual(rec.defaultsAskedFor, [copyOf(7)], "the copy's own defaults");
    assert.deepEqual(rec.vmLaunches, [
        {
            copyPath: copyOf(7),
            options: {permissionMode: 'auto', addDirs: 'docs', initialPrompt: 'Work on #7.'},
            show: false,
        },
    ]);
    assert.deepEqual(rec.localLaunches, []);
});

test('an issue start handed off reports each step as it goes, main’s hand-off lines among them', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec));
    const reported: string[] = [];

    /* When */
    await startIssueSessionWith(steps, {
        projectPath: PROJECT,
        issue: key(7),
        plan: plan([]),
        vm: VM,
        onStep: (step) => reported.push(step),
    });

    /* Then */
    assert.deepEqual(reported, [
        'Making the worktree on this Mac',
        'Getting the hand-off to dev@vm.local ready',
        'Connecting to dev@vm.local',
        'Handing app off to dev@vm.local',
        'Starting Claude on dev@vm.local',
    ]);
});

test('an issue start whose hand-off fails reports no launch step', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec, {refused: [worktreeOf(7)]}));
    const reported: string[] = [];

    /* When */
    await startIssueSessionWith(steps, {
        projectPath: PROJECT,
        issue: key(7),
        plan: plan([]),
        vm: VM,
        onStep: (step) => reported.push(step),
    });

    /* Then */
    assert.ok(!reported.includes('Starting Claude on dev@vm.local'));
});

test('an issue start here reports no steps', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec));
    const reported: string[] = [];

    /* When */
    await startIssueSessionWith(steps, {
        projectPath: PROJECT,
        issue: key(7),
        plan: plan([]),
        onStep: (step) => reported.push(step),
    });

    /* Then */
    assert.deepEqual(reported, []);
});

test('an issue start whose hand-off fails starts nothing and says the worktree is still here', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec, {answer: {ok: false, error: 'Could not reach dev@vm.local'}}));

    /* When */
    const result = await startIssueSessionWith(steps, {projectPath: PROJECT, issue: key(7), plan: plan([]), vm: VM});

    /* Then */
    assert.deepEqual(result, {
        ok: false,
        reason: 'Couldn’t hand it off to dev@vm.local: Could not reach dev@vm.local. The worktree is ready on this Mac.',
    });
    assert.deepEqual(rec.vmLaunches, []);
    assert.deepEqual(rec.localLaunches, []);
});

test('an issue start that is not handed off launches here as before', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec));

    /* When */
    const result = await startIssueSessionWith(steps, {projectPath: PROJECT, issue: key(7), plan: plan([])});

    /* Then */
    assert.deepEqual(result, {ok: true, sessionId: 'local-session'});
    assert.deepEqual(rec.handOffs, []);
    assert.deepEqual(rec.localLaunches, [worktreeOf(7)]);
});

// ── A level's start ──

test('a level handed off sends the project and every worktree, and starts one session in the project’s copy', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec));
    const issues: IssueKey[] = [key(1), key(4)];

    /* When */
    const report = await startLevelWith(steps, {projectPath: PROJECT, plan: plan([]), level: 2, issues, vm: VM});

    /* Then */
    assert.deepEqual(report, {started: 2, failed: [], sessionId: 'vm-session'});
    assert.deepEqual(rec.handOffs, [
        {localPath: PROJECT, hostKey: VM.key, worktrees: [worktreeOf(1), worktreeOf(4)], project: true},
    ]);
    assert.deepEqual(rec.defaultsAskedFor, [PROJECT_COPY]);
    assert.equal(rec.vmLaunches.length, 1);
    const [launch] = rec.vmLaunches;
    assert.equal(launch.copyPath, PROJECT_COPY);
    assert.equal(launch.show, false);
    assert.equal(launch.options.worktree, undefined);
    // `~` is not expanded in `--add-dir` on the VM, so the worktrees are named from the copy.
    assert.equal(launch.options.addDirs, 'docs,.claude/worktrees/1-issue,.claude/worktrees/4-issue');
    assert.match(launch.options.initialPrompt ?? '', /~\/projects\/app\/\.claude\/worktrees\/1-issue/);
    assert.doesNotMatch(launch.options.initialPrompt ?? '', /\/dev\/app/, 'no Mac paths in the prompt');
    assert.deepEqual(rec.localLaunches, []);
});

test('a level worktree that does not go over is a failed issue, and the rest start on the VM', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec, {refused: [worktreeOf(4)]}));

    /* When */
    const report = await startLevelWith(steps, {
        projectPath: PROJECT,
        plan: plan([]),
        level: 2,
        issues: [key(1), key(4)],
        vm: VM,
    });

    /* Then */
    assert.equal(report.started, 1);
    assert.deepEqual(report.failed, [
        {
            issue: key(4),
            reason: 'Couldn’t hand it off to dev@vm.local: the patch did not apply. The worktree is ready on this Mac.',
        },
    ]);
    assert.equal(rec.vmLaunches[0].options.addDirs, 'docs,.claude/worktrees/1-issue');
});

test('a level whose project could not be handed off fails every issue and starts nothing', async () => {
    /* Given */
    const rec = recorder();
    const steps = issueSteps(rec, vmSteps(rec, {answer: {ok: false, error: 'origin is not reachable'}}));

    /* When */
    const report = await startLevelWith(steps, {
        projectPath: PROJECT,
        plan: plan([]),
        level: 2,
        issues: [key(1), key(4)],
        vm: VM,
    });

    /* Then */
    assert.equal(report.started, 0);
    assert.deepEqual(
        report.failed.map(({issue}) => issue.number),
        [1, 4],
    );
    assert.match(report.failed[0].reason, /origin is not reachable\./);
    assert.deepEqual(rec.vmLaunches, []);
});

// ── A task's start ──

function taskSteps(rec: Recorded, projectPath = PROJECT): StartTaskSessionSteps {
    return {
        prepare: async () => ({
            kind: 'ready',
            projectPath,
            worktreePath: projectPath === PROJECT ? worktreeOf(9) : projectPath + '/.claude/worktrees/9-issue',
            branch: 'fix-the-login',
            prompt: 'Work on my task',
        }),
        defaultOptions: async (path) => {
            rec.defaultsAskedFor.push(path);
            return {};
        },
        launch: async (path) => {
            rec.localLaunches.push(path);
            return {ok: true, sessionId: 'local-session'};
        },
        started: async (_taskId, sessionId, path) => {
            rec.order.push(`linked ${sessionId} ${path}`);
            return {ok: true};
        },
        vm: vmSteps(rec),
    };
}

test('a task start handed off starts in the worktree’s copy on the VM and links it to the task’s project', async () => {
    /* Given */
    const rec = recorder();

    /* When */
    const result = await startTaskSessionWith(taskSteps(rec), {task: {id: 't1', title: 'Fix the login'}, vm: VM});

    /* Then */
    assert.deepEqual(result, {kind: 'started', sessionId: 'vm-session', projectPath: PROJECT});
    assert.deepEqual(
        rec.vmLaunches.map((launch) => launch.copyPath),
        [copyOf(9)],
    );
    assert.deepEqual(rec.order, ['hand off', 'launch on vm', `linked vm-session ${PROJECT}`]);
    assert.deepEqual(rec.localLaunches, []);
});

test('a task whose project is on a VM already starts there as it always has', async () => {
    /* Given */
    const rec = recorder();
    const vmProject = 'ssh://dev@vm.local/~/projects/other';

    /* When */
    await startTaskSessionWith(taskSteps(rec, vmProject), {task: {id: 't1', title: 'Fix the login'}, vm: VM});

    /* Then */
    assert.deepEqual(rec.handOffs, []);
    assert.deepEqual(rec.localLaunches, [vmProject + '/.claude/worktrees/9-issue']);
});

// ── The question ──

test('the question names the VM when there is one, and asks about a VM when there are several', () => {
    /* Given */
    const other: HandoffHost = {key: 'ci@build:2222', label: 'ci@build'};

    /* When */
    const one = handOffQuestion([VM]);
    const several = handOffQuestion([VM, other]);

    /* Then */
    assert.equal(one, 'Do you want to hand this off to dev@vm.local?');
    assert.equal(several, 'Do you want to hand this off to a VM?');
});

// ── The level's confirmation ──

test('the level’s confirmation asks about the VM and offers Start here and Hand off to it', async () => {
    /* Given */
    const {createElement} = await import('react');
    const {renderToStaticMarkup} = await import('react-dom/server');
    const {PlanViewContent} = await import('../src/renderer/ui/session-work/plan/PlanViewContent');
    const {diamond} = await import('./support/plans');
    const asked = {levelStart: {plan: key(1), level: 2, issues: [key(11), key(12)], phase: 'confirm' as const}};

    /* When */
    const withVm = renderToStaticMarkup(
        createElement(PlanViewContent, {plan: diamond(), issueActions: {...asked, vmHosts: [VM]}}),
    );
    const without = renderToStaticMarkup(createElement(PlanViewContent, {plan: diamond(), issueActions: asked}));

    /* Then */
    assert.match(withVm, /Do you want to hand this off to dev@vm\.local\?/);
    assert.match(withVm, />Start here</);
    assert.match(withVm, />Hand off to dev@vm\.local</);
    assert.doesNotMatch(without, /hand this off/);
    assert.match(without, />Start session</);
});

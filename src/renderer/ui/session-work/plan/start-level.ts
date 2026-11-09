/**
 * Start level (A1): one session for the plan's current level, which runs an
 * agent per Ready issue and governs them.
 *
 * Each issue gets its worktree the way Start session makes one (#125's
 * `prepare`), one after another: each makes a worktree in the same
 * repository, and git's worktree list wants one change at a time. Then one
 * session starts in the project, with every worktree added to it and a
 * prompt that hands each issue to its own agent (`levelSessionPrompt`).
 *
 * `startLevelWith` is the sequence alone, tested in node with fakes;
 * `issue-actions` hands it the real steps.
 */
import type {IssueKey, Plan, PlanLayout} from '../../../../domain/plan/model';
import type {IssueWorktreeResult} from '../../../../domain/plan/issue-session';
import {levelSessionPrompt, type LevelAgent} from '../../../../domain/plan/start';
import type {StartIssueSessionSteps} from './start-issue-session';
import type {HandoffHost, StartHandoffResult} from '../../../../application/services/project-handoff';
import {parseRemoteProjectPath} from '../../../../domain/project/remote-target';
import {notHandedOff, sentence} from '../../session-handoff/start-on-vm';

export interface LevelStartReport {
    /** How many issues got an agent in the level's session. */
    started: number;
    failed: {issue: IssueKey; reason: string}[];
    /** The level's session, when it started. */
    sessionId?: string;
}

export interface StartLevelRequest {
    /** The project the plan is shown for: the worktrees go under its repository, and the session starts in it. */
    projectPath: string;
    plan: Plan;
    level: number;
    issues: readonly IssueKey[];
    /** Hand the level off to this VM: the worktrees go there, and the session starts in the project's copy. */
    vm?: HandoffHost;
}

/** The issues Start level starts on `level`: its Ready ones, in row order. */
export function readyOnLevel(layout: PlanLayout, level: number): IssueKey[] {
    return (layout.levels[level - 1] ?? []).filter((issue) => layout.stateOf(issue) === 'ready');
}

/**
 * Make each issue's worktree in turn, a failure or a throw noted while the
 * rest go on; then start the one session on the worktrees that were made. The
 * session stays in the background, so the plan view stays on screen.
 */
export async function startLevelWith(
    steps: StartIssueSessionSteps,
    {projectPath, plan, level, issues, vm}: StartLevelRequest,
): Promise<LevelStartReport> {
    const agents: LevelAgent[] = [];
    const failed: LevelStartReport['failed'] = [];
    for (const issue of issues) {
        let prepared: IssueWorktreeResult;
        try {
            prepared = await steps.prepare({projectPath, issue, plan});
        } catch (err) {
            prepared = {ok: false, reason: (err as Error)?.message || 'Could not prepare the worktree'};
        }
        if (prepared.ok)
            agents.push({issue, worktreePath: prepared.worktreePath, branch: prepared.branch, prompt: prepared.prompt});
        else failed.push({issue, reason: prepared.reason});
    }
    if (!agents.length) return {started: 0, failed};
    if (vm) return startLevelOnVm(steps, vm, {projectPath, plan, level}, agents, failed);

    // The session governs from the project; `--worktree` would make it one of its own.
    const {worktree: _worktree, worktreeName: _worktreeName, ...defaults} = await steps.defaultOptions(projectPath);
    const addDirs = [defaults.addDirs, ...agents.map((agent) => agent.worktreePath)].filter(Boolean).join(',');
    const initialPrompt = levelSessionPrompt(plan, level, agents);
    let launched: Awaited<ReturnType<StartIssueSessionSteps['launch']>>;
    try {
        launched = await steps.launch(projectPath, {...defaults, addDirs, initialPrompt}, {show: false});
    } catch (err) {
        launched = {ok: false, reason: (err as Error)?.message || 'Could not start the session'};
    }
    if (!launched.ok) {
        const reason = 'The session didn’t start: ' + launched.reason;
        return {started: 0, failed: [...agents.map(({issue}) => ({issue, reason})), ...failed]};
    }
    return {started: agents.length, failed, sessionId: launched.sessionId};
}

/**
 * The level handed off to a VM: the project's copy made when the host has
 * none, every worktree sent over as a worktree of it, and the session started
 * in the copy with those worktrees added, named by their folders there. A
 * worktree that did not go is a failed issue; the rest start without it.
 */
async function startLevelOnVm(
    steps: StartIssueSessionSteps,
    vm: HandoffHost,
    {projectPath, plan, level}: Pick<StartLevelRequest, 'projectPath' | 'plan' | 'level'>,
    agents: LevelAgent[],
    failed: LevelStartReport['failed'],
): Promise<LevelStartReport> {
    const allFailed = (reason: string): LevelStartReport => ({
        started: 0,
        failed: [...agents.map(({issue}) => ({issue, reason})), ...failed],
    });
    if (!steps.vm) return allFailed(notHandedOff(vm, 'hand-off isn’t available here.'));
    let handed: StartHandoffResult;
    try {
        handed = await steps.vm.handOff(
            projectPath,
            vm.key,
            agents.map((agent) => agent.worktreePath),
            {project: true},
        );
    } catch (err) {
        handed = {ok: false, error: (err as Error).message || 'the hand-off stopped.'};
    }
    if (!handed.ok) return allFailed(notHandedOff(vm, sentence(handed.error)));
    const projectCopy = handed.projectCopy;
    const projectDir = projectCopy ? parseRemoteProjectPath(projectCopy)?.dir : null;
    if (!projectCopy || !projectDir) return allFailed(notHandedOff(vm, 'the VM did not say where the project went.'));

    const onVm: LevelAgent[] = [];
    for (const agent of agents) {
        const copy = handed.worktrees.find((worktree) => worktree.checkout === agent.worktreePath);
        const dir = copy?.ok ? parseRemoteProjectPath(copy.copyPath)?.dir : null;
        if (dir) onVm.push({...agent, worktreePath: dir});
        else
            failed.push({
                issue: agent.issue,
                reason: notHandedOff(
                    vm,
                    copy && !copy.ok ? sentence(copy.error) : 'the VM did not say where the worktree went.',
                ),
            });
    }
    if (!onVm.length) return {started: 0, failed};

    // `--add-dir` gets no `~` expanded on the VM, so a worktree inside the copy is named from it.
    const relative = (dir: string) => (dir.startsWith(projectDir + '/') ? dir.slice(projectDir.length + 1) : dir);
    const {worktree: _worktree, worktreeName: _worktreeName, ...defaults} = await steps.defaultOptions(projectCopy);
    const addDirs = [defaults.addDirs, ...onVm.map((agent) => relative(agent.worktreePath))].filter(Boolean).join(',');
    const initialPrompt = levelSessionPrompt(plan, level, onVm);
    let launched: Awaited<ReturnType<StartIssueSessionSteps['launch']>>;
    try {
        launched = await steps.vm.launch(projectCopy, {...defaults, addDirs, initialPrompt}, {show: false});
    } catch (err) {
        launched = {ok: false, reason: (err as Error)?.message || 'Could not start the session'};
    }
    if (!launched.ok) {
        const reason = 'The session didn’t start: ' + launched.reason;
        return {started: 0, failed: [...onVm.map(({issue}) => ({issue, reason})), ...failed]};
    }
    return {started: onVm.length, failed, sessionId: launched.sessionId};
}

/** What the plan view says once the level's session came back. */
export function levelStartLine(report: {started: number; failed: readonly unknown[]}): string {
    const total = report.started + report.failed.length;
    const agents = (n: number) => (n === 1 ? '1 agent' : `${n} agents`);
    if (!report.failed.length) return `Started a session with ${agents(report.started)}.`;
    if (!report.started) return 'The session didn’t start.';
    return `Started a session with ${report.started} of ${agents(total)}.`;
}

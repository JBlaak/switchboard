/**
 * Main's side of the project page, the plan pages and the Plan tab, as the e2e
 * host stubs answer it (e2e/support/main-process.ts), for component specs:
 * the overview, the plans, the merge queue, Session work's snapshot, the
 * pins, and the sessions a click starts. Each answers from the same e2e
 * fixtures (e2e/fixtures/plans.ts, merge-queue.ts, session-work.ts), so a
 * spec reads as its e2e one did.
 */
import {expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import type {FakeApi} from './fake-api';
import type {Answers} from './default-answers';
import type {CapturedFixture} from '../fixtures/captured';
import {sessionRow, terminalStatus} from '../../e2e/support/app';
import type {MergeQueueStub, PlansStub, SessionWorkStub} from '../../e2e/support/main-process';
import type {ProjectOverview, WorktreeOverview} from '../../src/domain/project/overview';
import type {IssueWorktreeResult} from '../../src/domain/plan/issue-session';
import type {Project} from '../../src/domain/project/project';

/** What main answers for the project page's other calls, as the e2e harness's real handlers did: no VM, no copies. */
export const PROJECT_PAGE_ANSWERS: Answers = {
    handoffHosts: [],
    projectCopies: [],
    schedulesWhere: null,
    canOpenSessionWork: false,
    rendererReady: undefined,
    issueSessions: {},
    projectTasks: [],
    sessionTasks: {},
    openExternal: undefined,
    writeClipboard: undefined,
    // The session tray of a session on screen: nothing known about it yet.
    getSessionLinks: [],
    getSessionStats: {contextUsed: null, messageCount: null, startedAt: null, branch: null, shell: null},
    savedPrompts: {global: [], project: []},
    workspaceEditor: {available: false, reason: 'No editor in the component harness'},
    resizeTerminal: undefined,
};

/**
 * `projectOverview` and `projectCleanWorktrees` as the e2e stub answers them,
 * by the end of the project's path (`Development/acme-api`): closed plans and
 * merged PRs only when asked, no plans while `plans: false`, the GitHub part
 * dated now, and Clean taking the superfluous worktrees out. `set` swaps
 * what the next call answers, as `setHostStub(app, 'projectOverview', …)` did.
 */
export function stubOverviews(api: FakeApi, initial: Record<string, ProjectOverview>) {
    let overviews = initial;
    const find = (projectPath: string) => Object.entries(overviews).find(([end]) => projectPath.endsWith('/' + end));
    api.handle('projectOverview', (projectPath, options) => {
        const found = find(projectPath);
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
                      : overview.github.pullRequests.filter((row) => row.pullRequest.state !== 'merged'),
              }
            : overview.github;
        return {...overview, projectPath, github};
    });
    api.handle('projectCleanWorktrees', (projectPath) => {
        const found = find(projectPath);
        if (!found) return {removed: [], failed: []};
        const [end, overview] = found;
        const superfluous = (w: WorktreeOverview): boolean =>
            !w.main && !w.locked && w.changedFiles === 0 && w.merged && w.running.length === 0;
        overviews = {...overviews, [end]: {...overview, worktrees: overview.worktrees.filter((w) => !superfluous(w))}};
        return {removed: overview.worktrees.filter(superfluous).map((w) => w.path), failed: []};
    });
    return {
        set(next: Record<string, ProjectOverview>) {
            overviews = next;
        },
    };
}

/**
 * The plan calls as the e2e `plans` stub answers them. With `prepareWorktrees`,
 * a worktree named after the issue, or the refusal over an existing branch;
 * `existingAsked` lists each `existing` asked for a branch that exists.
 * `set` swaps the stub, as `setHostStub(app, 'plans', …)` did.
 */
export function stubPlans(api: FakeApi, initial: PlansStub) {
    let plans = initial;
    const existingAsked: (string | null)[] = [];
    api.handle('sessionPlans', (sessionId) => plans.sessionPlans[sessionId] ?? null);
    api.handle('plan', (repo, number) => plans.plans?.[repo + '#' + number] ?? null);
    api.handle('projectPlans', (projectPath, options) => {
        const found = Object.entries(plans.projectPlans ?? {}).find(([end]) => projectPath.endsWith('/' + end));
        if (!found) return [];
        if (!found[1]) return null;
        return options?.closed ? found[1] : found[1].filter((plan) => plan.state === 'open');
    });
    api.handle('issueSessions', (repo) => plans.issueSessions?.[repo] ?? {});
    api.handle('prepareIssueWorktree', (request): IssueWorktreeResult => {
        if (!plans.prepareWorktrees) throw new Error('prepareIssueWorktree is not stubbed');
        const branch = request.issue.number + '-issue';
        const worktreePath = request.projectPath + '/.claude/worktrees/' + branch;
        const exists = plans.existingBranches?.issues.includes(request.issue.number);
        if (exists) existingAsked.push(request.existing ?? null);
        if (exists && !request.existing) {
            return {
                ok: false,
                reason: `Branch ${branch} already exists`,
                existing: {
                    branch,
                    worktreePath,
                    main: false,
                    changedFiles: 2,
                    ahead: 1,
                    sessionId: plans.existingBranches!.session,
                },
            };
        }
        const prompt = (request.existing === 'reuse' ? 'Continue work on #' : 'Work on #') + request.issue.number + '.';
        return {ok: true, worktreePath, branch, prompt};
    });
    return {
        existingAsked,
        set(next: PlansStub) {
            plans = next;
        },
    };
}

/** The `queue:*` calls as the e2e `mergeQueue` stub answers them; `api.callsTo` lists what was asked. */
export function stubMergeQueue(api: FakeApi, stub: MergeQueueStub): void {
    api.answer('queueNudge', stub.nudge);
    api.answer('queueForgetNudge', undefined);
    api.answer('queueSettleNudges', undefined);
    api.answer('queueFix', stub.fix);
    api.answer('queueRetry', stub.retry);
    api.answer('queueOptIn', stub.optIn);
    api.answer('queueErrandStarted', {ok: true});
    api.answer('queueErrandAbandoned', {ok: true});
    api.answer('queueErrands', stub.errands);
    api.answer('ciJobQueue', stub.ciJobs);
    api.answer('ciJobBump', stub.bump);
}

/** Session work's calls as the e2e `sessionWork` stub answers them; a session with no snapshot stays a skeleton. */
export function stubSessionWork(api: FakeApi, work: SessionWorkStub): void {
    api.handle('canOpenSessionWork', (sessionId) => work.canOpen.includes(sessionId));
    api.handle('openSessionWork', (sessionId) => work.snapshots[sessionId] ?? new Promise(() => {}));
    api.handle('getSessionWorkDiff', (request) => {
        const diff = work.diffs?.[request.itemId];
        if (diff === 'never') return new Promise(() => {});
        return diff ?? {files: [], source: null};
    });
    api.handle('getCheckLog', (request) => work.checkLogs?.[request.checkRunUrl] ?? null);
    api.answer('closeSessionWork', undefined);
}

/**
 * The pins main stores: each toggle flips it and answers, and `getProjects`
 * carries them from then on, as the repository's would.
 */
export function stubPins(api: FakeApi, fixture: CapturedFixture): void {
    const projectPins = new Map<string, number>();
    const planPins = new Map<string, {repository: string; number: number; title: string; pinnedAt: number}[]>();
    const dress = (projects: Project[]): Project[] =>
        projects.map((project) => ({
            ...project,
            pinnedAt: projectPins.get(project.projectPath) ?? project.pinnedAt,
            pinnedIssuePlans: planPins.get(project.projectPath) ?? project.pinnedIssuePlans,
        }));
    api.handle('getProjects', (showArchived) => dress(showArchived ? fixture.projectsWithArchived : fixture.projects));
    api.handle('toggleProjectPin', (projectPath) => {
        const pinned = !projectPins.has(projectPath);
        if (pinned) projectPins.set(projectPath, Date.now());
        else projectPins.delete(projectPath);
        return {pinned};
    });
    api.handle('toggleIssuePlanPin', (projectPath, repository, number, title) => {
        const pins = planPins.get(projectPath) ?? [];
        const others = pins.filter((p) => p.repository !== repository || p.number !== number);
        const pinned = others.length === pins.length;
        planPins.set(projectPath, pinned ? [...others, {repository, number, title, pinnedAt: Date.now()}] : others);
        return {pinned};
    });
}

/**
 * Sessions as main runs them, with no process: `openTerminal` starts one,
 * `stopSession` stops it, and `getActiveSessions`/`getActiveTerminals` answer
 * what runs. `api.callsTo('openTerminal')` is what the fake CLI's launch
 * records were in e2e: the id, the directory, new or resumed, and the options
 * (prompt, added directories).
 */
export function runSessions(api: FakeApi): {running: Map<string, string>} {
    const running = new Map<string, string>();
    // What a resume is launched with: the settings as stored, no project's own.
    api.handle('getEffectiveSettings', () => ({...((api.settings.global as object | undefined) ?? {})}));
    api.handle('openTerminal', (id, projectPath) => {
        running.set(id, projectPath);
        return {ok: true};
    });
    api.handle('stopSession', (id) => {
        running.delete(id);
        return {ok: true};
    });
    api.handle('getActiveSessions', () => [...running.keys()]);
    api.handle('getActiveTerminals', () => [...running].map(([sessionId, projectPath]) => ({sessionId, projectPath})));
    return {running};
}

/** Click a session's row and wait for it to run on screen, as e2e's `openSession` does (needs `runSessions`). */
export async function openSession(page: Page, api: FakeApi, label: string, sessionId: string): Promise<void> {
    await sessionRow(page, label).first().click();
    await expect.poll(() => api.callsTo('openTerminal').some(([id]) => id === sessionId)).toBe(true);
    await expect(terminalStatus(page)).toHaveText('Running');
}

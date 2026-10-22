import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PlanService } from '../src/application/services/plan-service';
import {
  ProjectOverviewService, type RunningSession,
} from '../src/application/services/project-overview-service';
import type { GitHubAvailability } from '../src/application/ports/github-cli';
import type { Plan, PlanIssue, PlanSummary } from '../src/domain/plan/model';
import type {
  ProjectGitHubOverview, RepositoryIssue, RepositoryPullRequest, WorktreeSummary,
} from '../src/domain/project/overview';
import { fakeProjectGitHub, fakeWorktrees } from './support/fakes';

const REPO = 'JBlaak/switchboard';
const PROJECT = '/code/switchboard';
const WORKTREE = PROJECT + '/.claude/worktrees/114-zoom-pan';

function planIssue(number: number, state: 'open' | 'closed' = 'open'): PlanIssue {
  return {
    repository: REPO, number, title: '#' + number, state, closedAs: null, updatedAt: '2026-10-01T00:00:00Z',
    blockedBy: [], pullRequests: [], summary: '', acceptance: [],
  };
}

function plan(number: number, issues: PlanIssue[]): Plan {
  return { repository: REPO, number, title: 'Plan ' + number, parent: null, issues, outside: [] };
}

function summary(number: number, state: 'open' | 'closed' = 'open'): PlanSummary {
  return { repository: REPO, number, title: 'Plan ' + number, state, updatedAt: '2026-10-01T00:00:00Z', open: 1, total: 2, current: 1, levels: 1 };
}

function issue(number: number, overrides: Partial<RepositoryIssue> = {}): RepositoryIssue {
  return {
    repository: REPO, number, title: '#' + number, state: 'open', labels: [],
    updatedAt: '2026-10-01T00:00:00Z', parent: null, subIssues: 0, ...overrides,
  };
}

function pullRequest(number: number, closes: number[], state: 'open' | 'merged' = 'open'): RepositoryPullRequest {
  return {
    repository: REPO, number, title: 'PR ' + number, state, draft: false, headRef: 'branch-' + number,
    updatedAt: '2026-10-01T00:00:00Z', checks: { state: 'passing', failing: 0 }, review: null,
    closes: closes.map((n) => ({ repository: REPO, number: n })),
  };
}

function checkout(path: string, main = false): WorktreeSummary {
  return { path, branch: main ? 'main' : 'branch', main, locked: false, changedFiles: 0, ahead: 0, merged: false, lastCommitAt: null };
}

interface World {
  origin: string | null;
  isRepository: boolean;
  plans: Plan[];
  summaries: PlanSummary[];
  issues: RepositoryIssue[];
  pullRequests: RepositoryPullRequest[];
  worktrees: WorktreeSummary[];
  owners: Record<string, string>;
  running: RunningSession[];
  /** False: every `gh` read answers null. */
  gh: boolean;
  availability: GitHubAvailability;
}

function setUp(overrides: Partial<World> = {}) {
  const world: World = {
    origin: 'git@github.com:JBlaak/switchboard.git', isRepository: true,
    plans: [], summaries: [], issues: [], pullRequests: [], worktrees: [checkout(PROJECT, true)],
    owners: {}, running: [], gh: true, availability: 'ok',
    ...overrides,
  };
  let now = 1_000_000;
  const clock = { now: () => now };
  /** Every `gh` request, in the order made. */
  const calls: string[] = [];

  const projectReads = fakeProjectGitHub();
  const github = {
    async available() {
      calls.push('available');
      return world.availability;
    },
    async issuesIn(repo: string, options: { closed: boolean }) {
      calls.push('issuesIn');
      projectReads.issues = world.gh ? world.issues : null;
      return projectReads.issuesIn(repo, options);
    },
    async pullRequestsIn(repo: string, options: { merged: boolean }) {
      calls.push('pullRequestsIn');
      projectReads.pullRequests = world.gh ? world.pullRequests : null;
      return projectReads.pullRequestsIn(repo, options);
    },
    async plan(repo: string, number: number) {
      calls.push('plan #' + number);
      if (!world.gh) return null;
      return world.plans.find((candidate) => candidate.repository === repo && candidate.number === number) ?? null;
    },
    async plansIn(_repo: string, { closed }: { closed: boolean }) {
      calls.push('plansIn');
      if (!world.gh) return null;
      return world.summaries.filter((candidate) => closed || candidate.state === 'open');
    },
    async plansOf() { return []; },
    async closingIssues() { return []; },
  };

  const git = {
    worktreeRoot: async (cwd: string) => (world.isRepository ? cwd : null),
    ...fakeWorktrees(),
  };
  git.byRepository.set(PROJECT, world.worktrees);
  const remotes = { originUrl: async () => world.origin };

  const plans = new PlanService({
    locate: () => null,
    transcripts: { locations: () => [], readSession: () => null },
    git, remotes, github, clock,
  });
  const service = new ProjectOverviewService({
    plans,
    owners: { issueSessions: async () => world.owners },
    running: () => world.running,
    git, remotes, github, clock,
  });

  return { world, calls, git, service, advance: (ms: number) => { now += ms; } };
}

function answered(github: ProjectGitHubOverview | null) {
  assert.ok(github && github.ok, 'expected a GitHub answer');
  return github;
}

test('a project with a GitHub remote answers its plans, loose issues, PRs and worktrees in one call', async () => {
  /* Given */
  const { service } = setUp({
    summaries: [summary(112)],
    plans: [plan(112, [planIssue(113), planIssue(114)])],
    issues: [
      issue(112, { subIssues: 2 }),
      issue(113, { parent: { repository: REPO, number: 112 } }),
      issue(114, { parent: { repository: REPO, number: 112 } }),
      issue(150),
    ],
    pullRequests: [pullRequest(119, [114])],
    worktrees: [checkout(PROJECT, true), checkout(WORKTREE)],
  });

  /* When */
  const answer = await service.overview(PROJECT);

  /* Then */
  assert.equal(answer.repository, REPO);
  assert.equal(answer.remote, false);
  const github = answered(answer.github);
  assert.equal(github.stale, false);
  assert.equal(github.fetchedAt, 1_000_000);
  assert.deepEqual(github.plans.map((row) => row.plan.number), [112]);
  assert.deepEqual(github.plans[0].issues.map((row) => row.issue.number), [113, 114]);
  assert.deepEqual(github.loose.map((row) => row.issue.number), [150]);
  assert.deepEqual(github.pullRequests.map((row) => [row.pullRequest.number, row.plan?.number]), [[119, 112]]);
  assert.deepEqual(answer.worktrees.map((worktree) => worktree.path), [PROJECT, WORKTREE]);
});

test('an issue with a running session that owns it says so, and so does its worktree', async () => {
  /* Given */
  const { service } = setUp({
    issues: [issue(150)],
    worktrees: [checkout(PROJECT, true), checkout(WORKTREE)],
    owners: { [REPO + '#150']: 'session-1' },
    running: [
      { sessionId: 'session-1', projectPath: WORKTREE },
      { sessionId: 'session-2', projectPath: PROJECT },
      { sessionId: 'elsewhere', projectPath: '/code/other' },
    ],
  });

  /* When */
  const answer = await service.overview(PROJECT);

  /* Then */
  const github = answered(answer.github);
  assert.deepEqual(github.loose[0].status, { kind: 'running', sessionId: 'session-1' });
  assert.deepEqual(answer.worktrees.map((worktree) => worktree.running), [['session-2'], ['session-1']]);
  assert.deepEqual([...answer.running].sort(), ['session-1', 'session-2']);
});

test('a second call within 30 s does not touch gh', async () => {
  /* Given */
  const { service, calls, advance } = setUp({ summaries: [summary(112)], plans: [plan(112, [planIssue(113)])] });
  await service.overview(PROJECT);
  const first = calls.length;

  /* When */
  advance(29_000);
  const answer = await service.overview(PROJECT);

  /* Then */
  assert.equal(calls.length, first);
  assert.equal(answered(answer.github).stale, false);
});

test('a call after 30 s reads GitHub again', async () => {
  /* Given */
  const { service, calls, advance } = setUp({ summaries: [summary(112)], plans: [plan(112, [planIssue(113)])] });
  await service.overview(PROJECT);
  calls.length = 0;

  /* When */
  advance(30_000);
  const answer = await service.overview(PROJECT);

  /* Then */
  assert.deepEqual([...calls].sort(), ['issuesIn', 'plan #112', 'plansIn', 'pullRequestsIn']);
  assert.equal(answered(answer.github).fetchedAt, 1_030_000);
});

test('a failed refresh serves the previous answer as stale, with when it was fetched', async () => {
  /* Given */
  const { world, service, advance } = setUp({ issues: [issue(150)] });
  await service.overview(PROJECT);
  world.gh = false;

  /* When */
  advance(45_000);
  const answer = await service.overview(PROJECT);

  /* Then */
  const github = answered(answer.github);
  assert.equal(github.stale, true);
  assert.equal(github.fetchedAt, 1_000_000);
  assert.deepEqual(github.loose.map((row) => row.issue.number), [150]);
});

test('a refresh after a failed one is fresh again', async () => {
  /* Given */
  const { world, service, advance } = setUp({ issues: [issue(150)] });
  await service.overview(PROJECT);
  world.gh = false;
  advance(45_000);
  await service.overview(PROJECT);
  world.gh = true;

  /* When */
  advance(1_000);
  const answer = await service.overview(PROJECT);

  /* Then */
  const github = answered(answer.github);
  assert.equal(github.stale, false);
  assert.equal(github.fetchedAt, 1_046_000);
});

for (const [availability, reason] of [['missing', 'no-gh'], ['unauthenticated', 'signed-out'], ['ok', 'unreachable']] as const) {
  test(`never answered, with gh ${availability}, says ${reason}`, async () => {
    /* Given */
    const { service } = setUp({ gh: false, availability, worktrees: [checkout(PROJECT, true)] });

    /* When */
    const answer = await service.overview(PROJECT);

    /* Then */
    assert.deepEqual(answer.github, { ok: false, reason });
    assert.equal(answer.repository, REPO);
    assert.deepEqual(answer.worktrees.map((worktree) => worktree.path), [PROJECT]);
  });
}

test('closed plans and merged PRs are only answered when asked for', async () => {
  /* Given */
  const { service } = setUp({
    summaries: [summary(112), summary(90, 'closed')],
    plans: [plan(112, [planIssue(113)]), plan(90, [planIssue(91, 'closed')])],
    pullRequests: [pullRequest(119, [113]), pullRequest(95, [91], 'merged')],
  });

  /* When */
  const open = answered((await service.overview(PROJECT)).github);
  const all = answered((await service.overview(PROJECT, { closed: true, merged: true })).github);

  /* Then */
  assert.deepEqual(open.plans.map((row) => row.plan.number), [112]);
  assert.deepEqual(open.pullRequests.map((row) => row.pullRequest.number), [119]);
  assert.deepEqual(all.plans.map((row) => row.plan.number), [112, 90]);
  assert.deepEqual(all.pullRequests.map((row) => [row.pullRequest.number, row.plan?.number]), [[119, 112], [95, 90]]);
});

test('a merged PR never stands for an open issue\'s PR', async () => {
  /* Given */
  const { service } = setUp({ issues: [issue(150)], pullRequests: [pullRequest(95, [150], 'merged')] });

  /* When */
  const github = answered((await service.overview(PROJECT, { merged: true })).github);

  /* Then */
  assert.equal(github.loose[0].pullRequest, null);
  assert.deepEqual(github.pullRequests.map((row) => row.pullRequest.number), [95]);
});

test('a project without a GitHub remote answers its worktrees without calling gh', async () => {
  /* Given */
  const { service, calls } = setUp({ origin: null, running: [{ sessionId: 'session-1', projectPath: PROJECT }] });

  /* When */
  const answer = await service.overview(PROJECT);

  /* Then */
  assert.equal(answer.repository, null);
  assert.equal(answer.github, null);
  assert.deepEqual(answer.worktrees.map((worktree) => [worktree.path, worktree.running]), [[PROJECT, ['session-1']]]);
  assert.deepEqual(calls, []);
});

test('a project that is not a git repository answers its running sessions only', async () => {
  /* Given */
  const { service, calls, git } = setUp({ isRepository: false, running: [{ sessionId: 'session-1', projectPath: PROJECT + '/sub' }] });

  /* When */
  const answer = await service.overview(PROJECT);

  /* Then */
  assert.deepEqual(answer.worktrees, []);
  assert.deepEqual(answer.running, ['session-1']);
  assert.deepEqual(calls, []);
  assert.deepEqual(git.calls, []);
});

test('an ssh project answers its running sessions only, with no git or gh reads', async () => {
  /* Given */
  const remote = 'ssh://joris@build-box/srv/app';
  let gitAsked = false;
  const { service, calls, git } = setUp({
    running: [{ sessionId: 'remote-1', projectPath: remote }, { sessionId: 'local-1', projectPath: PROJECT }],
  });
  const worktreeRoot = git.worktreeRoot;
  git.worktreeRoot = async (cwd) => { gitAsked = true; return worktreeRoot(cwd); };

  /* When */
  const answer = await service.overview(remote);

  /* Then */
  assert.deepEqual(answer, {
    projectPath: remote, remote: true, repository: null, github: null, worktrees: [], running: ['remote-1'],
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(git.calls, []);
  assert.equal(gitAsked, false);
});

test('a parent in another repository leaves the issue loose in this one', async () => {
  /* Given */
  const { service } = setUp({ issues: [issue(150, { parent: { repository: 'JBlaak/other', number: 150 } })] });

  /* When */
  const github = answered((await service.overview(PROJECT)).github);

  /* Then */
  assert.deepEqual(github.loose.map((row) => [row.issue.number, row.issue.parent]), [[150, null]]);
  assert.deepEqual(github.plans, []);
});

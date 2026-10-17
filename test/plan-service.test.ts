import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLAN_CACHE_MS, PlanService, type PlanServiceDeps } from '../src/application/services/plan-service';
import type { GitHubCli, PullRequestCloses } from '../src/application/ports/github-cli';
import type { IssueKey, Plan, PlanIssue, PlanSummary } from '../src/domain/plan/model';
import type { Session, SessionPullRequest } from '../src/domain/session/session';
import type { TranscriptLocation } from '../src/application/ports/transcript-store';

const REPO = 'JBlaak/switchboard';
const PROJECT = '/code/switchboard';

function issue(number: number, updatedAt = '2026-10-01T00:00:00Z', repository = REPO): PlanIssue {
  return {
    repository, number, title: '#' + number, state: 'open', closedAs: null, updatedAt,
    blockedBy: [], pullRequests: [], summary: '', acceptance: [],
  };
}

function plan(number: number, issues: PlanIssue[], repository = REPO): Plan {
  return { repository, number, title: 'Plan ' + number, parent: null, issues, outside: [] };
}

function summary(number: number, state: 'open' | 'closed' = 'open'): PlanSummary {
  return { repository: REPO, number, title: 'Plan ' + number, state, updatedAt: '', open: 1, total: 2, current: 1, levels: 2 };
}

interface World {
  /** Branch names the session's transcripts were written from. */
  branches: string[];
  pullRequests: SessionPullRequest[];
  /** GitHub's issues, by `owner/repo#n`: their parent and, for a plan, the plan. */
  parents: Record<string, IssueKey>;
  plans: Plan[];
  /** `owner/repo` → its plans; closed ones are only answered with `closed`. */
  repoPlans: PlanSummary[];
  /** PR number → the issues it closes. */
  closes: Record<number, IssueKey[]>;
  /** False: `gh` is missing or signed out, and every read answers null. */
  gh: boolean;
  origin: string | null;
  isRepository: boolean;
}

function setUp(overrides: Partial<World> = {}) {
  const world: World = {
    branches: [], pullRequests: [], parents: {}, plans: [], repoPlans: [], closes: {},
    gh: true, origin: 'git@github.com:JBlaak/switchboard.git', isRepository: true,
    ...overrides,
  };
  const calls: string[] = [];
  let now = 1_000_000;

  const github: Pick<GitHubCli, 'plan' | 'plansIn' | 'parentsOf' | 'closingIssues'> = {
    async plan(repo, number) {
      calls.push(`plan ${repo}#${number}`);
      if (!world.gh) return null;
      return world.plans.find((candidate) => candidate.repository === repo && candidate.number === number) ?? null;
    },
    async plansIn(repo, { closed }) {
      calls.push(`plansIn ${repo} ${closed}`);
      if (!world.gh) return null;
      return world.repoPlans.filter((candidate) => candidate.repository === repo && (closed || candidate.state === 'open'));
    },
    async parentsOf(issues) {
      calls.push('parentsOf ' + issues.map((key) => key.repository + '#' + key.number).join(','));
      if (!world.gh) return null;
      const found = new Map<string, IssueKey>();
      for (const key of issues) {
        const parent = world.parents[key.repository + '#' + key.number];
        if (parent) found.set(parent.repository + '#' + parent.number, parent);
      }
      return [...found.values()];
    },
    async closingIssues(repo, numbers) {
      calls.push(`closingIssues ${repo} ${numbers.join(',')}`);
      if (!world.gh) return null;
      return numbers.filter((n) => world.closes[n]).map((n): PullRequestCloses => ({ number: n, closes: world.closes[n] }));
    },
  };

  const deps: PlanServiceDeps = {
    locate: (sessionId) => (sessionId === 'session-1' ? { folder: '-code-switchboard', projectPath: PROJECT } : null),
    transcripts: {
      locations: () => world.branches.map((branch): TranscriptLocation => ({ cwd: PROJECT, branch, fromSubagent: false })),
      readSession: () => ({ pullRequests: world.pullRequests }) as unknown as Session,
    },
    git: { worktreeRoot: async (cwd) => (world.isRepository ? cwd : null) },
    remotes: { originUrl: async () => world.origin },
    github,
    clock: { now: () => now },
  };

  return {
    world,
    calls,
    service: new PlanService(deps),
    advance: (ms: number) => { now += ms; },
  };
}

const imageCompare = plan(112, [issue(113), issue(114, '2026-10-17T10:00:00Z')]);

test('a session on branch 114-zoom-pan-stage gets #112\'s plan', async () => {
  /* Given */
  const { service } = setUp({
    branches: ['main', '114-zoom-pan-stage'],
    parents: { [REPO + '#114']: { repository: REPO, number: 112 } },
    plans: [imageCompare],
  });

  /* When */
  const answer = await service.sessionPlans('session-1');

  /* Then */
  assert.ok(answer);
  assert.deepEqual(answer.plans, [imageCompare]);
});

test('a session owns the issues its PRs close, whatever its branch is called (S1)', async () => {
  /* Given */
  const { service, calls } = setUp({
    branches: ['worktree-agent-abc'],
    pullRequests: [{ number: 119, url: 'https://github.com/JBlaak/switchboard/pull/119', repository: REPO }],
    closes: { 119: [{ repository: REPO, number: 113 }] },
    parents: { [REPO + '#113']: { repository: REPO, number: 112 } },
    plans: [imageCompare],
  });

  /* When */
  const answer = await service.sessionPlans('session-1');

  /* Then */
  assert.deepEqual(answer!.plans.map((found) => found.number), [112]);
  assert.ok(calls.includes(`closingIssues ${REPO} 119`));
  assert.ok(calls.includes(`parentsOf ${REPO}#113`));
});

test('a branch and a PR naming the same issue ask for its parent once', async () => {
  /* Given */
  const { service, calls } = setUp({
    branches: ['114-zoom-pan-stage'],
    pullRequests: [{ number: 119, url: 'https://github.com/JBlaak/switchboard/pull/119', repository: '' }],
    closes: { 119: [{ repository: REPO, number: 114 }] },
  });

  /* When */
  await service.sessionPlans('session-1');

  /* Then */
  assert.ok(calls.includes(`parentsOf ${REPO}#114`));
});

test('a session whose issues sit in two plans gets both, the most recently active first (W2)', async () => {
  /* Given */
  const older = plan(70, [issue(71, '2026-09-01T00:00:00Z')]);
  const { service } = setUp({
    branches: ['71-old-work', '114-zoom-pan-stage'],
    parents: {
      [REPO + '#71']: { repository: REPO, number: 70 },
      [REPO + '#114']: { repository: REPO, number: 112 },
    },
    plans: [older, imageCompare],
  });

  /* When */
  const answer = await service.sessionPlans('session-1');

  /* Then */
  assert.deepEqual(answer!.plans.map((found) => found.number), [112, 70]);
});

test('the repository\'s open plans always come along as others (W3)', async () => {
  /* Given */
  const { service } = setUp({
    branches: ['114-zoom-pan-stage'],
    parents: { [REPO + '#114']: { repository: REPO, number: 112 } },
    plans: [imageCompare],
    repoPlans: [summary(121), summary(112, 'closed')],
  });

  /* When */
  const answer = await service.sessionPlans('session-1');

  /* Then */
  assert.deepEqual(answer!.others.map((other) => other.number), [121]);
});

test('a session without issues gets no plans, only the others, without asking for parents', async () => {
  /* Given */
  const { service, calls } = setUp({ branches: ['main'], repoPlans: [summary(121)] });

  /* When */
  const answer = await service.sessionPlans('session-1');

  /* Then */
  assert.deepEqual(answer, { plans: [], others: [summary(121)] });
  assert.ok(!calls.some((call) => call.startsWith('parentsOf')));
});

test('an issue without a parent leads to no plan', async () => {
  /* Given */
  const { service } = setUp({ branches: ['114-zoom-pan-stage'], plans: [imageCompare] });

  /* When */
  const answer = await service.sessionPlans('session-1');

  /* Then */
  assert.deepEqual(answer!.plans, []);
});

test('gh missing or signed out: sessionPlans, plan and projectPlans answer null', async () => {
  /* Given */
  const { service } = setUp({
    gh: false,
    branches: ['114-zoom-pan-stage'],
    pullRequests: [{ number: 119, url: 'https://github.com/JBlaak/switchboard/pull/119', repository: REPO }],
  });

  /* When */
  const answers = await Promise.all([
    service.sessionPlans('session-1'),
    service.plan(REPO, 112),
    service.projectPlans(PROJECT, { closed: false }),
  ]);

  /* Then */
  assert.deepEqual(answers, [null, null, null]);
});

test('a second call within 30 s does not run gh again', async () => {
  /* Given */
  const { service, calls, advance } = setUp({
    branches: ['114-zoom-pan-stage'],
    parents: { [REPO + '#114']: { repository: REPO, number: 112 } },
    plans: [imageCompare],
  });
  const first = await service.sessionPlans('session-1');
  const asked = calls.length;

  /* When */
  advance(PLAN_CACHE_MS - 1);
  const second = await service.sessionPlans('session-1');
  const plan = await service.plan(REPO, 112);

  /* Then */
  assert.equal(calls.length, asked);
  assert.equal(second, first);
  assert.deepEqual(plan, imageCompare);
});

test('after 30 s gh is asked again', async () => {
  /* Given */
  const { service, calls, advance } = setUp({ repoPlans: [summary(121)] });
  await service.projectPlans(PROJECT, { closed: false });

  /* When */
  advance(PLAN_CACHE_MS);
  await service.projectPlans(PROJECT, { closed: false });

  /* Then */
  assert.equal(calls.filter((call) => call.startsWith('plansIn')).length, 2);
});

test('two asks at once share one gh request', async () => {
  /* Given */
  const { service, calls } = setUp({ plans: [imageCompare] });

  /* When */
  const [a, b] = await Promise.all([service.plan(REPO, 112), service.plan(REPO, 112)]);

  /* Then */
  assert.equal(a, b);
  assert.equal(calls.length, 1);
});

test('a null answer is not kept, so the next ask tries gh again', async () => {
  /* Given */
  const { service, world, calls } = setUp({ gh: false, plans: [imageCompare] });
  assert.equal(await service.plan(REPO, 112), null);

  /* When */
  world.gh = true;
  const plan = await service.plan(REPO, 112);

  /* Then */
  assert.deepEqual(plan, imageCompare);
  assert.equal(calls.length, 2);
});

test('projectPlans lists the open plans with current and levels, and the closed ones only with closed: true', async () => {
  /* Given */
  const { service } = setUp({ repoPlans: [summary(121), summary(112, 'closed')] });

  /* When */
  const open = await service.projectPlans(PROJECT, { closed: false });
  const all = await service.projectPlans(PROJECT, { closed: true });

  /* Then */
  assert.deepEqual(open!.map((found) => [found.number, found.current, found.levels]), [[121, 1, 2]]);
  assert.deepEqual(all!.map((found) => found.number), [121, 112]);
});

test('projectPlans for a folder that is not a GitHub repository answers null', async () => {
  /* Given */
  const notGit = setUp({ isRepository: false });
  const noOrigin = setUp({ origin: null });
  const gitlab = setUp({ origin: 'git@gitlab.com:group/repo.git' });

  /* When */
  const answers = await Promise.all([
    notGit.service.projectPlans('/tmp/notes', { closed: false }),
    noOrigin.service.projectPlans(PROJECT, { closed: false }),
    gitlab.service.projectPlans(PROJECT, { closed: false }),
  ]);

  /* Then */
  assert.deepEqual(answers, [null, null, null]);
  assert.deepEqual([...notGit.calls, ...noOrigin.calls, ...gitlab.calls], []);
});

test('a session that is unknown or not in a GitHub repository has no plans', async () => {
  /* Given */
  const { service } = setUp({ origin: null });

  /* When */
  const answers = await Promise.all([service.sessionPlans('session-1'), service.sessionPlans('nobody')]);

  /* Then */
  assert.deepEqual(answers, [null, null]);
});

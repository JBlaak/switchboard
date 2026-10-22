import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupOverview, type OverviewInput, type OverviewIssue, type OverviewPlanSource, type OverviewPullRequest,
} from '../src/domain/plan/project-overview';
import { issueKeyString, type IssueKey, type Plan, type PlanIssue } from '../src/domain/plan/model';

const REPO = 'JBlaak/switchboard';

function key(number: number): IssueKey {
  return { repository: REPO, number };
}

function planIssue(number: number, fields: Partial<PlanIssue> = {}): PlanIssue {
  return {
    repository: REPO, number, title: 'Issue ' + number, state: 'open', closedAs: null,
    updatedAt: '2026-10-01T00:00:00Z', blockedBy: [], pullRequests: [], summary: '', acceptance: [],
    ...fields,
  };
}

function closed(number: number, fields: Partial<PlanIssue> = {}): PlanIssue {
  return planIssue(number, { state: 'closed', closedAs: 'completed', ...fields });
}

function plan(number: number, issues: PlanIssue[], fields: Partial<OverviewPlanSource> = {}): OverviewPlanSource {
  const read: Plan = { repository: REPO, number, title: 'Plan ' + number, parent: null, issues, outside: [] };
  return { plan: read, state: 'open', updatedAt: '2026-10-01T00:00:00Z', ...fields };
}

interface Issue extends OverviewIssue { labels: string[] }
interface PullRequest extends OverviewPullRequest { draft: boolean }

function issue(number: number, fields: Partial<Issue> = {}): Issue {
  return { number, title: 'Issue ' + number, updatedAt: '2026-10-01T00:00:00Z', parent: null, subIssueCount: 0, labels: [], ...fields };
}

function pr(number: number, closes: number[]): PullRequest {
  return { number, closes, draft: false };
}

function input(fields: Partial<OverviewInput<Issue, PullRequest>>): OverviewInput<Issue, PullRequest> {
  return { repository: REPO, plans: [], issues: [], pullRequests: [], sessions: { owners: {}, running: new Set() }, ...fields };
}

const numbers = (rows: { issue: { number: number } }[]) => rows.map((row) => row.issue.number);

// ── Loose issues ──

test('an open sub-issue of a plan never appears among the loose issues', () => {
  /* Given */
  const overview = input({
    plans: [plan(167, [planIssue(170, { blockedBy: [] }), planIssue(172, { blockedBy: [key(170)] })])],
    issues: [
      issue(167, { subIssueCount: 2 }),
      issue(170, { parent: 167 }),
      issue(172, { parent: 167 }),
      issue(180),
    ],
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.deepEqual(numbers(groups.loose), [180]);
  assert.deepEqual(numbers(groups.plans[0].issues), [170, 172]);
});

test('a sub-issue whose plan was not read is still not loose', () => {
  /* Given */
  const overview = input({ issues: [issue(201, { parent: 150 }), issue(202)] });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.deepEqual(numbers(groups.loose), [202]);
});

test('loose issues are newest first and keep the caller\'s fields', () => {
  /* Given */
  const overview = input({
    issues: [
      issue(10, { updatedAt: '2026-10-02T00:00:00Z' }),
      issue(11, { updatedAt: '2026-10-05T00:00:00Z', labels: ['bug'] }),
      issue(12, { updatedAt: '2026-10-03T00:00:00Z' }),
    ],
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.deepEqual(numbers(groups.loose), [11, 12, 10]);
  assert.deepEqual(groups.loose[0].issue.labels, ['bug']);
});

// ── Issues with sub-issues ──

test('an issue with sub-issues is a plan before it is levelled', () => {
  /* Given */
  const overview = input({
    issues: [
      issue(300, { subIssueCount: 3, title: 'New epic' }),
      issue(302, { parent: 300 }),
      issue(301, { parent: 300 }),
    ],
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.equal(groups.plans.length, 1);
  const epic = groups.plans[0];
  assert.deepEqual(epic.plan, { ...key(300), title: 'New epic' });
  assert.equal(epic.levelled, false);
  assert.deepEqual(numbers(epic.issues), [301, 302]);
  assert.deepEqual(epic.progress, { closed: 1, total: 3, current: null, levels: 0, segments: ['closed', 'ready', 'ready'] });
  assert.deepEqual(groups.loose, []);
});

test('a read plan is not counted again as an issue with sub-issues', () => {
  /* Given */
  const overview = input({
    plans: [plan(167, [planIssue(170)])],
    issues: [issue(167, { subIssueCount: 1 }), issue(170, { parent: 167 })],
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.equal(groups.plans.length, 1);
  assert.equal(groups.plans[0].levelled, true);
});

// ── A plan's row ──

test('a plan lists its issues in level order with closed ones last, and its progress', () => {
  /* Given */
  const overview = input({
    plans: [plan(167, [
      planIssue(173, { blockedBy: [key(170)] }),
      closed(170),
      planIssue(171),
      planIssue(174, { blockedBy: [key(173)] }),
    ])],
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  const epic = groups.plans[0];
  assert.deepEqual(numbers(epic.issues), [171, 173, 174, 170]);
  assert.deepEqual(epic.issues.map((row) => row.level), [1, 2, 3, 1]);
  assert.deepEqual(epic.progress, {
    closed: 1, total: 4, current: 1, levels: 3, segments: ['closed', 'ready', 'ready', 'locked'],
  });
});

// ── Pull requests ──

test('a PR closing two issues of one plan is attached to both and to the plan once', () => {
  /* Given */
  const shared = pr(190, [170, 171]);
  const overview = input({
    plans: [plan(167, [planIssue(170), planIssue(171), planIssue(172)])],
    pullRequests: [shared, pr(191, [999])],
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  const epic = groups.plans[0];
  assert.equal(epic.issues.find((row) => row.issue.number === 170)!.pullRequest, shared);
  assert.equal(epic.issues.find((row) => row.issue.number === 171)!.pullRequest, shared);
  assert.equal(epic.issues.find((row) => row.issue.number === 172)!.pullRequest, null);
  assert.deepEqual(epic.pullRequests, [shared]);
  assert.deepEqual(groups.pullRequests.map((row) => [row.pullRequest.number, row.plan]), [[190, key(167)], [191, null]]);
  assert.deepEqual(groups.pullRequests[0].closes, [key(170), key(171)]);
});

test('an issue with two open PRs knows the newest', () => {
  /* Given */
  const overview = input({ issues: [issue(50)], pullRequests: [pr(60, [50]), pr(61, [50])] });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.equal(groups.loose[0].pullRequest!.number, 61);
});

// ── Plan order ──

test('plans: open before closed, running first, then by last activity', () => {
  /* Given */
  const overview = input({
    plans: [
      plan(1, [planIssue(11)], { updatedAt: '2026-10-09T00:00:00Z', state: 'closed' }),
      plan(2, [planIssue(21)], { updatedAt: '2026-10-02T00:00:00Z' }),
      plan(3, [planIssue(31, { updatedAt: '2026-10-08T00:00:00Z' })], { updatedAt: '2026-10-03T00:00:00Z' }),
      plan(4, [planIssue(41)], { updatedAt: '2026-10-01T00:00:00Z' }),
    ],
    sessions: { owners: { [issueKeyString(key(41))]: 'session-a' }, running: new Set(['session-a']) },
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.deepEqual(groups.plans.map((row) => row.plan.number), [4, 3, 2, 1]);
  assert.deepEqual(groups.plans.map((row) => row.running), [true, false, false, false]);
  assert.equal(groups.plans[1].lastActivity, '2026-10-08T00:00:00Z');
});

test('an owning session that is not running does not make the plan running', () => {
  /* Given */
  const overview = input({
    plans: [plan(1, [planIssue(11)])],
    sessions: { owners: { [issueKeyString(key(11))]: 'session-a' }, running: new Set() },
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  assert.equal(groups.plans[0].running, false);
  assert.equal(groups.plans[0].issues[0].session, 'session-a');
});

// ── One status per row, and startable ──

test('a running session wins over what the issue waits on and its PR', () => {
  /* Given */
  const overview = input({
    plans: [plan(1, [planIssue(10), planIssue(11, { blockedBy: [key(10)] })])],
    pullRequests: [pr(80, [11])],
    sessions: { owners: { [issueKeyString(key(11))]: 'session-a' }, running: new Set(['session-a']) },
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  const row = groups.plans[0].issues.find((candidate) => candidate.issue.number === 11)!;
  assert.deepEqual(row.status, { kind: 'running', sessionId: 'session-a' });
  assert.equal(row.startable, false);
});

test('what an issue waits on wins over its PR', () => {
  /* Given */
  const overview = input({
    plans: [plan(1, [planIssue(10), closed(9), planIssue(11, { blockedBy: [key(10), key(9)] })])],
    pullRequests: [pr(80, [11])],
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  const row = groups.plans[0].issues.find((candidate) => candidate.issue.number === 11)!;
  assert.deepEqual(row.status, { kind: 'waiting', on: [key(10)] });
  assert.equal(row.startable, false);
});

test('an issue that waits on nothing shows its PR', () => {
  /* Given */
  const review = pr(80, [11]);
  const overview = input({ plans: [plan(1, [closed(10), planIssue(11, { blockedBy: [key(10)] })])], pullRequests: [review] });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  const row = groups.plans[0].issues.find((candidate) => candidate.issue.number === 11)!;
  assert.deepEqual(row.status, { kind: 'pull-request', pullRequest: review });
  assert.equal(row.startable, true);
});

test('an open issue, not blocked and without an owner, is startable; owned or closed is not', () => {
  /* Given */
  const overview = input({
    plans: [plan(1, [planIssue(10), planIssue(11), closed(12)])],
    sessions: { owners: { [issueKeyString(key(11))]: 'session-idle' }, running: new Set() },
  });

  /* When */
  const groups = groupOverview(overview);

  /* Then */
  const startable = Object.fromEntries(groups.plans[0].issues.map((row) => [row.issue.number, row.startable]));
  assert.deepEqual(startable, { 10: true, 11: false, 12: false });
  assert.equal(groups.plans[0].issues.find((row) => row.issue.number === 11)!.status, null);
});

/**
 * The project page's Pull requests and Worktrees sections and its edge states
 * (#175): Show merged and a worktree's start in the project-page slice, which
 * PR and worktree rows are on screen and what they say, the cursor rows and
 * keys they add, and which state the page is in from the overview's answer.
 *
 * The page in the real app, with a stubbed overview, is in
 * e2e/tests/project-page.spec.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { NO_MEMORY, overviewRequest } from '../src/renderer/state/project-page-slice';
import {
  checksPill, cursorId, pageRows, planRows, plansView, pullRequestRows, pullRequestsView, reviewText, worktreeRows,
  worktreesView,
} from '../src/renderer/ui/project-page/page-rows';
import { pageKeyAction } from '../src/renderer/ui/project-page/page-keys';
import {
  AUTH_COMMAND, ageInWords, githubPart, remoteHost, showsWorktrees, staleLine, unavailableMessage,
} from '../src/renderer/ui/project-page/page-state';
import { groupOverview } from '../src/domain/plan/project-overview';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { Plan, PlanIssue } from '../src/domain/plan/model';
import type {
  ProjectIssue, ProjectOverview, ProjectPullRequest, WorktreeOverview,
} from '../src/domain/project/overview';

const REPO = 'acme/app';
const APP = '/dev/app';
const SHOWN = { showMerged: false, filter: '' };

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(projectPath = APP): RendererState {
  return run(initialRendererState(), { type: 'projectPageRestored', projectPath, memory: NO_MEMORY });
}

// ── An overview: a plan of two issues, PRs open, draft and merged, and four checkouts ──

function planIssue(number: number, title: string): PlanIssue {
  return {
    repository: REPO, number, title, state: 'open', closedAs: null, updatedAt: '2026-10-10T00:00:00Z',
    blockedBy: [], pullRequests: [], summary: '', acceptance: [],
  };
}

const LOGIN: Plan = {
  repository: REPO, number: 10, title: 'Login rework', parent: null, outside: [],
  issues: [planIssue(11, 'Cookie store'), planIssue(12, 'Redirect loop')],
};

function issue(number: number, title: string, fields: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    repository: REPO, number, title, state: 'open', updatedAt: '2026-10-10T00:00:00Z', labels: [],
    parent: null, subIssueCount: 0, ...fields,
  };
}

function pullRequest(number: number, title: string, headRef: string, fields: Partial<ProjectPullRequest> = {}): ProjectPullRequest {
  return {
    repository: REPO, number, title, state: 'open', draft: false, headRef, updatedAt: '2026-10-17T00:00:00Z',
    checks: { state: 'passing', failing: 0 }, review: null, closes: [], ...fields,
  };
}

function worktree(path: string, fields: Partial<WorktreeOverview> = {}): WorktreeOverview {
  return {
    path, branch: null, main: false, locked: false, changedFiles: 0, ahead: 0, merged: false, lastCommitAt: null,
    running: [], ...fields,
  };
}

const WORKTREES: WorktreeOverview[] = [
  worktree(APP + '/.claude/worktrees/old', { branch: 'old-work', merged: true, lastCommitAt: 1_000 }),
  worktree(APP + '/.claude/worktrees/limiter', { branch: 'rate-limiter', ahead: 1, lastCommitAt: 3_000 }),
  worktree(APP, { branch: 'main', main: true, lastCommitAt: 500 }),
  worktree(APP + '/.claude/worktrees/redirect', { branch: 'fix/redirect', changedFiles: 2, ahead: 3, lastCommitAt: 4_000, running: ['s1'] }),
  worktree(APP + '/.claude/worktrees/detached', { lastCommitAt: null }),
];

function overview(fields: Partial<ProjectOverview> = {}): ProjectOverview {
  const issues = [
    issue(10, 'Login rework', { subIssueCount: 2 }),
    issue(11, 'Cookie store', { parent: 10 }),
    issue(12, 'Redirect loop', { parent: 10 }),
  ];
  const sessions = { owners: {}, running: new Set<string>() };
  const plans = [{ plan: LOGIN, state: 'open' as const, updatedAt: '2026-10-10T00:00:00Z' }];
  const groups = groupOverview<ProjectIssue, ProjectPullRequest>({
    repository: REPO, plans, issues, sessions,
    pullRequests: [
      pullRequest(20, 'Stop the redirect loop', 'fix/redirect', { closes: [12], checks: { state: 'running', failing: 0 } }),
      pullRequest(21, 'Try a rate limiter', 'rate-limiter', { draft: true }),
      pullRequest(22, 'Bump express', 'dependabot/express', { checks: { state: 'failing', failing: 2 }, review: 'review_required' }),
    ],
  });
  // Merged ones come after the open ones, grouped on their own, as main answers them.
  groups.pullRequests.push(...groupOverview<ProjectIssue, ProjectPullRequest>({
    repository: REPO, plans: [], issues: [], sessions,
    pullRequests: [pullRequest(19, 'Old work', 'old-work', { state: 'merged', closes: [11] })],
  }).pullRequests);
  return {
    projectPath: APP, remote: false, repository: REPO, github: { ok: true, fetchedAt: 0, stale: false, ...groups },
    worktrees: WORKTREES, running: ['s1'], ...fields,
  };
}

function numbers(rows: readonly { pullRequest: { number: number } }[]): number[] {
  return rows.map(row => row.pullRequest.number);
}

function github(o: ProjectOverview) {
  assert.ok(o.github?.ok);
  return o.github;
}

// ── Show merged and a worktree's start, in the slice ──

test('Show merged flips, and the overview is asked for with merged PRs as it says', () => {
  /* Given */
  const onPage = run(initialRendererState(),
    { type: 'projectOpened', projectPath: APP, view: { kind: 'overview' } },
    { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });

  /* When */
  const shown = run(onPage, { type: 'projectShowMergedToggled' });

  /* Then */
  assert.deepEqual(overviewRequest(onPage), { projectPath: APP, closed: false, merged: false });
  assert.deepEqual(overviewRequest(shown), { projectPath: APP, closed: false, merged: true });
});

test('an answer asked before Show merged flipped is dropped', () => {
  /* Given */
  const shown = run(opened(), { type: 'projectShowMergedToggled' });

  /* When */
  const stale = run(shown, { type: 'projectOverviewAnswered', projectPath: APP, closed: false, merged: false, overview: overview() });
  const fresh = run(shown, { type: 'projectOverviewAnswered', projectPath: APP, closed: false, merged: true, overview: overview() });

  /* Then */
  assert.equal(stale.projectPage.overview, null);
  assert.ok(fresh.projectPage.overview);
});

test('Show merged starts off each time a page opens', () => {
  /* Given */
  const shown = run(opened(), { type: 'projectShowMergedToggled' });

  /* When */
  const reopened = run(shown, { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });

  /* Then */
  assert.equal(shown.projectPage.showMerged, true);
  assert.equal(reopened.projectPage.showMerged, false);
});

test('starting a session in a worktree shows it starting, then clears, or says why it did not start', () => {
  /* Given */
  const path = APP + '/.claude/worktrees/limiter';
  const asked = run(opened(), { type: 'projectWorktreeStartAsked', path });

  /* When */
  const started = run(asked, { type: 'projectWorktreeStartAnswered', path, result: { ok: true, sessionId: 's2' } });
  const failed = run(asked, { type: 'projectWorktreeStartAnswered', path, result: { ok: false, reason: 'No claude' } });
  const other = run(asked, { type: 'projectWorktreeStartAnswered', path: APP, result: { ok: false, reason: 'No claude' } });

  /* Then */
  assert.deepEqual(asked.projectPage.worktreeStart, { path, phase: 'starting' });
  assert.equal(started.projectPage.worktreeStart, null);
  assert.deepEqual(failed.projectPage.worktreeStart, { path, phase: 'failed', reason: 'No claude' });
  assert.equal(other.projectPage, asked.projectPage);
});

// ── Pull requests ──

test('the section lists the open PRs, and Show merged adds the merged ones after them', () => {
  /* Given */
  const groups = github(overview());

  /* When */
  const open = pullRequestsView(groups, SHOWN);
  const all = pullRequestsView(groups, { ...SHOWN, showMerged: true });

  /* Then */
  assert.deepEqual(numbers(open), [20, 21, 22]);
  assert.deepEqual(numbers(all), [20, 21, 22, 19]);
});

test('a PR that closes an issue in a plan carries that plan for its chip, and is the issue’s PR pill', () => {
  /* Given */
  const groups = github(overview());

  /* When */
  const rows = pullRequestsView(groups, SHOWN);
  const plans = plansView(groups, { expandedPlans: [REPO + '#10'], showClosed: false, filter: '', looseExpanded: false });

  /* Then */
  assert.deepEqual(rows[0].plan, { repository: REPO, number: 10 });
  assert.equal(rows[1].plan, null);
  const redirect = plans.plans[0].issues.find(row => row.issue.number === 12);
  assert.equal(redirect?.status?.kind, 'pull-request');
  assert.equal(redirect?.status?.kind === 'pull-request' && redirect.status.pullRequest.number, 20);
});

test('the filter finds a PR by number, title or head branch', () => {
  /* Given */
  const groups = github(overview());

  /* When */
  const byBranch = pullRequestsView(groups, { ...SHOWN, filter: 'dependabot' });
  const byNumber = pullRequestsView(groups, { ...SHOWN, filter: '#21' });
  const byTitle = pullRequestsView(groups, { ...SHOWN, filter: 'redirect LOOP' });

  /* Then */
  assert.deepEqual(numbers(byBranch), [22]);
  assert.deepEqual(numbers(byNumber), [21]);
  assert.deepEqual(numbers(byTitle), [20]);
});

test('the checks pill says passing, running or how many fail, and nothing without checks', () => {
  /* When */
  const pills = [
    checksPill({ state: 'passing', failing: 0 }),
    checksPill({ state: 'running', failing: 0 }),
    checksPill({ state: 'failing', failing: 2 }),
    checksPill({ state: 'none', failing: 0 }),
  ];

  /* Then */
  assert.deepEqual(pills, [
    { tone: 'passing', text: '✓ passing' },
    { tone: 'running', text: '● running' },
    { tone: 'failing', text: '✕ 2 failing' },
    null,
  ]);
});

test('the review state reads in words, and a draft or merged PR says so instead', () => {
  /* Given */
  const pr = pullRequest(1, 'A', 'a');

  /* When */
  const texts = [
    reviewText({ ...pr, review: 'approved' }),
    reviewText({ ...pr, review: 'changes_requested' }),
    reviewText({ ...pr, review: 'review_required' }),
    reviewText(pr),
    reviewText({ ...pr, draft: true, review: 'approved' }),
    reviewText({ ...pr, state: 'merged', review: 'approved' }),
  ];

  /* Then */
  assert.deepEqual(texts, ['approved', 'changes requested', 'review requested', 'no review yet', 'draft', 'merged']);
});

// ── Worktrees ──

test('worktrees list the main checkout first, then the rest by last commit, newest first', () => {
  /* When */
  const rows = worktreesView(overview(), '');

  /* Then */
  assert.deepEqual(rows.map(row => row.title), ['main', 'fix/redirect', 'rate-limiter', 'old-work', 'detached']);
});

test('a worktree row says what changed, how far ahead it is and its PR; the main one names its folder', () => {
  /* When */
  const rows = worktreesView(overview(), '');

  /* Then */
  assert.deepEqual(rows.map(row => row.meta), [
    'app · clean',
    '2 changed · ↑3 · PR #20',
    'clean · ↑1 · PR #21',
    'merged in #19 · safe to remove',
    'detached · clean',
  ]);
});

test('a merged worktree with no merged PR known still says it is safe to remove', () => {
  /* Given */
  const groups = github(overview());
  const openOnly: ProjectOverview = { ...overview(), github: { ...groups, pullRequests: pullRequestsView(groups, SHOWN) } };

  /* When */
  const rows = worktreesView(openOnly, '');

  /* Then */
  assert.equal(rows.find(row => row.title === 'old-work')?.meta, 'merged · safe to remove');
});

test('Start session is offered on a worktree with no session running that is not merged', () => {
  /* When */
  const rows = worktreesView(overview(), '');

  /* Then */
  assert.deepEqual(rows.map(row => [row.title, row.running, row.startable]), [
    ['main', false, true],
    ['fix/redirect', true, false],
    ['rate-limiter', false, true],
    ['old-work', false, false],
    ['detached', false, true],
  ]);
});

test('the filter finds a worktree by branch or folder', () => {
  /* When */
  const rows = worktreesView(overview(), 'limiter');

  /* Then */
  assert.deepEqual(rows.map(row => row.title), ['rate-limiter']);
});

// ── The cursor and the keys ──

test('the cursor walks plans, then pull requests, then sessions, then worktrees', () => {
  /* Given */
  const o = overview();
  const plans = planRows(plansView(github(o), { expandedPlans: [], showClosed: false, filter: '', looseExpanded: false }));

  /* When */
  const rows = pageRows({
    plans,
    pullRequests: pullRequestRows(pullRequestsView(github(o), SHOWN)),
    sessions: [{ kind: 'session', id: cursorId.session('s1'), sessionId: 's1' }],
    worktrees: worktreeRows(worktreesView(o, '')).slice(0, 2),
  });

  /* Then */
  assert.deepEqual(rows.map(row => row.id), [
    'plan:acme/app#10',
    'pr:acme/app#20', 'pr:acme/app#21', 'pr:acme/app#22',
    'session:s1',
    'worktree:' + APP, 'worktree:' + APP + '/.claude/worktrees/redirect',
  ]);
});

test('↵ on a pull request opens it on GitHub; on a worktree it does nothing', () => {
  /* Given */
  const o = overview();
  const rows = pageRows({
    plans: [], sessions: [],
    pullRequests: pullRequestRows(pullRequestsView(github(o), SHOWN)),
    worktrees: worktreeRows(worktreesView(o, '')),
  });

  /* When */
  const onPr = pageKeyAction('Enter', rows, 'pr:acme/app#21');
  const onWorktree = pageKeyAction('Enter', rows, 'worktree:' + APP);

  /* Then */
  assert.deepEqual(onPr, { kind: 'open-pull-request', pullRequest: { repository: REPO, number: 21 } });
  assert.equal(onWorktree, null);
});

test('S starts a session in a worktree with none running, and does nothing on a busy or merged one, or a PR', () => {
  /* Given */
  const o = overview();
  const rows = pageRows({
    plans: [], sessions: [],
    pullRequests: pullRequestRows(pullRequestsView(github(o), SHOWN)),
    worktrees: worktreeRows(worktreesView(o, '')),
  });
  const limiter = APP + '/.claude/worktrees/limiter';

  /* When */
  const startable = pageKeyAction('S', rows, 'worktree:' + limiter);
  const lower = pageKeyAction('s', rows, 'worktree:' + limiter);
  const busy = pageKeyAction('S', rows, 'worktree:' + APP + '/.claude/worktrees/redirect');
  const merged = pageKeyAction('S', rows, 'worktree:' + APP + '/.claude/worktrees/old');
  const onPr = pageKeyAction('S', rows, 'pr:acme/app#20');

  /* Then */
  assert.deepEqual(startable, { kind: 'start-worktree', path: limiter });
  assert.deepEqual(lower, startable);
  assert.deepEqual([busy, merged, onPr], [null, null, null]);
});

// ── The edge states ──

test('with no answer yet the page is loading, and the worktrees wait for it too', () => {
  /* When */
  const part = githubPart(null, APP);
  const other = githubPart(overview({ projectPath: '/dev/other' }), APP);

  /* Then */
  assert.deepEqual(part, { kind: 'loading' });
  assert.deepEqual(other, { kind: 'loading' });
  assert.equal(showsWorktrees(null, APP), true);
});

test('gh missing, signed out or GitHub unreachable with nothing read before: one message, why', () => {
  /* When */
  const parts = (['no-gh', 'signed-out', 'unreachable'] as const)
    .map(reason => githubPart(overview({ github: { ok: false, reason } }), APP));

  /* Then */
  assert.deepEqual(parts, [
    { kind: 'unavailable', reason: 'no-gh' },
    { kind: 'unavailable', reason: 'signed-out' },
    { kind: 'unavailable', reason: 'unreachable' },
  ]);
});

test('the message names gh auth login when gh is missing or signed out, and no command when GitHub is unreachable', () => {
  /* When */
  const signedOut = unavailableMessage('signed-out');
  const missing = unavailableMessage('no-gh');
  const unreachable = unavailableMessage('unreachable');

  /* Then */
  assert.equal(signedOut.title, 'Plans, issues and pull requests come from the GitHub CLI');
  assert.equal(signedOut.before + signedOut.command + signedOut.after, 'Run gh auth login in a terminal, then try again.');
  assert.equal(missing.command, AUTH_COMMAND);
  assert.match(missing.before, /Install the GitHub CLI/);
  assert.equal(unreachable.command, null);
});

test('no GitHub remote: no GitHub part, and the worktrees still show when there are checkouts', () => {
  /* Given */
  const local = overview({ repository: null, github: null });
  const notGit = overview({ repository: null, github: null, worktrees: [] });

  /* When */
  const part = githubPart(local, APP);

  /* Then */
  assert.deepEqual(part, { kind: 'none' });
  assert.equal(showsWorktrees(local, APP), true);
  assert.equal(showsWorktrees(notGit, APP), false);
});

test('an ssh project is remote at once, names its host, and shows no worktrees', () => {
  /* Given */
  const path = 'ssh://joris@build.movelab/srv/deploy';

  /* When */
  const part = githubPart(null, path);

  /* Then */
  assert.deepEqual(part, { kind: 'remote', host: 'joris@build.movelab:22' });
  assert.equal(remoteHost('ssh://ci@runner:2222'), 'ci@runner:2222');
  assert.equal(showsWorktrees(null, path), false);
});

test('an answer kept after a failed refresh is stale, as of when it was read', () => {
  /* Given */
  const stale = overview();
  const groups = github(stale);

  /* When */
  const part = githubPart({ ...stale, github: { ...groups, stale: true, fetchedAt: 1_000 } }, APP);

  /* Then */
  assert.deepEqual(part, { kind: 'ok', stale: true, fetchedAt: 1_000 });
});

test('the stale line says how old the data is, in words', () => {
  /* When */
  const line = staleLine(0, 6 * 60_000 + 5_000);

  /* Then */
  assert.equal(line, 'Couldn’t reach GitHub. Showing what it said 6 minutes ago.');
  assert.deepEqual([ageInWords(10_000), ageInWords(60_000), ageInWords(2 * 3_600_000), ageInWords(26 * 3_600_000)],
    ['just now', '1 minute ago', '2 hours ago', '1 day ago']);
});

test('nothing open: the sections answer no rows, for one quiet line each', () => {
  /* Given */
  const empty = groupOverview<ProjectIssue, ProjectPullRequest>({
    repository: REPO, plans: [], issues: [], pullRequests: [], sessions: { owners: {}, running: new Set() },
  });

  /* When */
  const prs = pullRequestsView(empty, SHOWN);
  const plans = plansView(empty, { expandedPlans: [], showClosed: false, filter: '', looseExpanded: false });

  /* Then */
  assert.deepEqual(prs, []);
  assert.deepEqual([plans.plans.length, plans.loose.length], [0, 0]);
});

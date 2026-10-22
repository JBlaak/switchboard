/**
 * The project page's Plans & issues section and keys (#174): the overview kept
 * in the project-page slice, which rows are on screen (expanded plans, Show
 * closed, Show N more, the filter), the rows the cursor walks across
 * sections, what each key does, when the overview is asked for, and the
 * recent-plans memory that opens the plan viewed last expanded.
 *
 * The page in the real app, with a stubbed overview, is in
 * e2e/tests/project-page.spec.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { NO_MEMORY, overviewRequest } from '../src/renderer/state/project-page-slice';
import {
  LOOSE_SHOWN, cursorId, matchesFilter, pageRows, planRows, plansView, plansViewOf, progressSegments, runningCount,
  sessionRows,
} from '../src/renderer/ui/project-page/page-rows';
import type { PageRow, PlansViewOptions } from '../src/renderer/ui/project-page/page-rows';
import { pageKeyAction } from '../src/renderer/ui/project-page/page-keys';
import {
  RECENT_PLANS_CAP, parseRecentPlans, rememberPlan, withRecentPlan,
} from '../src/renderer/ui/project-page/recent-plans';
import { groupOverview } from '../src/domain/plan/project-overview';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { Plan, PlanIssue } from '../src/domain/plan/model';
import type { ProjectIssue, ProjectOverview, ProjectPullRequest } from '../src/domain/project/overview';

const REPO = 'acme/app';
const APP = '/dev/app';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function opened(projectPath = APP, memory = NO_MEMORY): RendererState {
  return run(initialRendererState(), { type: 'projectPageRestored', projectPath, memory });
}

// ── An overview: one open plan of four issues over three levels, a closed plan, loose issues ──

function planIssue(number: number, title: string, fields: Partial<PlanIssue> = {}): PlanIssue {
  return {
    repository: REPO, number, title, state: 'open', closedAs: null, updatedAt: '2026-10-10T00:00:00Z',
    blockedBy: [], pullRequests: [], summary: '', acceptance: [], ...fields,
  };
}

const LOGIN: Plan = {
  repository: REPO, number: 10, title: 'Login rework', parent: null, outside: [],
  issues: [
    planIssue(11, 'Cookie store', { state: 'closed', closedAs: 'completed' }),
    planIssue(12, 'Redirect loop', { blockedBy: [{ repository: REPO, number: 11 }] }),
    planIssue(13, 'Remember me', { blockedBy: [{ repository: REPO, number: 11 }] }),
    planIssue(14, 'Single sign-on', { blockedBy: [{ repository: REPO, number: 12 }] }),
  ],
};

const POSTGRES: Plan = {
  repository: REPO, number: 20, title: 'Move to Postgres', parent: null, outside: [],
  issues: [planIssue(21, 'Dump and restore', { state: 'closed', closedAs: 'completed' })],
};

function loose(number: number, title: string, labels: string[] = []): ProjectIssue {
  return {
    repository: REPO, number, title, state: 'open', updatedAt: `2026-10-${String(30 - (number % 20)).padStart(2, '0')}T00:00:00Z`,
    labels: labels.map(name => ({ name, color: 'ededed' })), parent: null, subIssueCount: 0,
  };
}

function overview(looseCount = 3): ProjectOverview {
  const issues: ProjectIssue[] = [
    { ...loose(10, 'Login rework'), subIssueCount: 4 },
    ...[12, 13, 14].map(n => ({ ...loose(n, LOGIN.issues.find(i => i.number === n)!.title), parent: 10 })),
    ...Array.from({ length: looseCount }, (_, i) => loose(100 + i, 'Loose issue ' + (100 + i), i === 0 ? ['bug'] : [])),
  ];
  const groups = groupOverview<ProjectIssue, ProjectPullRequest>({
    repository: REPO,
    plans: [
      { plan: LOGIN, state: 'open', updatedAt: '2026-10-10T00:00:00Z' },
      { plan: POSTGRES, state: 'closed', updatedAt: '2026-09-01T00:00:00Z' },
    ],
    issues,
    pullRequests: [],
    sessions: { owners: { [REPO + '#12']: 'session-a' }, running: new Set(['session-a']) },
  });
  return {
    projectPath: APP, remote: false, repository: REPO, running: ['session-a'], worktrees: [],
    github: { ok: true, fetchedAt: 1, stale: false, ...groups },
  };
}

function groups(o: ProjectOverview = overview()) {
  assert.ok(o.github?.ok);
  return o.github;
}

const SHOWN: PlansViewOptions = { expandedPlans: [], showClosed: false, filter: '', looseExpanded: false };

function titles(rows: readonly { issue: { title: string } }[]): string[] {
  return rows.map(row => row.issue.title);
}

// ── The overview in the slice ──

test('the overview is kept for the project whose page is open', () => {
  /* Given */
  const state = opened();

  /* When */
  const next = run(state, { type: 'projectOverviewAnswered', projectPath: APP, closed: false, merged: false, overview: overview() });

  /* Then */
  assert.equal(next.projectPage.overview?.repository, REPO);
});

test('an answer for another project, or one asked before Show closed flipped, is dropped', () => {
  /* Given */
  const state = run(opened(), { type: 'projectShowClosedToggled' });

  /* When */
  const other = run(state, { type: 'projectOverviewAnswered', projectPath: '/dev/other', closed: true, merged: false, overview: overview() });
  const stale = run(state, { type: 'projectOverviewAnswered', projectPath: APP, closed: false, merged: false, overview: overview() });

  /* Then */
  assert.equal(other.projectPage.overview, null);
  assert.equal(stale.projectPage.overview, null);
});

test('reopening the same project keeps its last answer on screen; another project starts without one', () => {
  /* Given */
  const answered = run(opened(), { type: 'projectOverviewAnswered', projectPath: APP, closed: false, merged: false, overview: overview() }, { type: 'projectLooseExpanded' });

  /* When */
  const same = run(answered, { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });
  const other = run(answered, { type: 'projectPageRestored', projectPath: '/dev/other', memory: NO_MEMORY });

  /* Then */
  assert.ok(same.projectPage.overview);
  assert.equal(same.projectPage.looseExpanded, false);
  assert.equal(other.projectPage.overview, null);
});

test('→ expands a plan once and ← collapses it, each a no-op when it already is', () => {
  /* Given */
  const state = opened();

  /* When */
  const expanded = run(state, { type: 'projectPlanExpanded', plan: REPO + '#10' }, { type: 'projectPlanExpanded', plan: REPO + '#10' });
  const collapsed = run(expanded, { type: 'projectPlanCollapsed', plan: REPO + '#10' });

  /* Then */
  assert.deepEqual(expanded.projectPage.expandedPlans, [REPO + '#10']);
  assert.deepEqual(collapsed.projectPage.expandedPlans, []);
  assert.equal(run(collapsed, { type: 'projectPlanCollapsed', plan: REPO + '#10' }).projectPage, collapsed.projectPage);
});

test('starting a session on an issue shows it starting, then clears, or says why it did not start', () => {
  /* Given */
  const asked = run(opened(), { type: 'projectIssueStartAsked', issue: REPO + '#13' });

  /* When */
  const started = run(asked, { type: 'projectIssueStartAnswered', issue: REPO + '#13', result: { ok: true, sessionId: 's1' } });
  const failed = run(asked, { type: 'projectIssueStartAnswered', issue: REPO + '#13', result: { ok: false, reason: 'Branch exists' } });

  /* Then */
  assert.deepEqual(asked.projectPage.start, { issue: REPO + '#13', phase: 'starting' });
  assert.equal(started.projectPage.start, null);
  assert.deepEqual(failed.projectPage.start, { issue: REPO + '#13', phase: 'failed', reason: 'Branch exists' });
});

// ── When the overview is asked for ──

test('the overview is asked for while the page shows its overview, with closed plans as Show closed says', () => {
  /* Given */
  const onPage = run(initialRendererState(),
    { type: 'projectOpened', projectPath: APP, view: { kind: 'overview' } },
    { type: 'projectPageRestored', projectPath: APP, memory: { expandedPlans: [], showClosed: true } });

  /* When */
  const request = overviewRequest(onPage);

  /* Then */
  assert.deepEqual(request, { projectPath: APP, closed: true, merged: false });
});

test('nothing is asked while the page is closed, shows one of its plans, or has not read its memory back yet', () => {
  /* Given */
  const restoring = run(initialRendererState(), { type: 'projectOpened', projectPath: APP, view: { kind: 'overview' } });
  const inPlan = run(opened(), { type: 'projectOpened', projectPath: APP, view: { kind: 'plan', repository: REPO, number: 10 } });
  const closed = run(opened(), { type: 'projectOpened', projectPath: APP, view: { kind: 'overview' } }, { type: 'projectClosed' });

  /* When */
  const requests = [restoring, inPlan, closed].map(overviewRequest);

  /* Then */
  assert.deepEqual(requests, [null, null, null]);
});

// ── Which rows are on screen ──

test('a plan is one row, and expanded it shows its issues in level order, closed ones last', () => {
  /* Given */
  const options = { ...SHOWN, expandedPlans: [REPO + '#10'] };

  /* When */
  const view = plansView(groups(), options);

  /* Then */
  assert.deepEqual(view.plans.map(p => p.plan.plan.title), ['Login rework']);
  assert.deepEqual(titles(view.plans[0].issues), ['Redirect loop', 'Remember me', 'Single sign-on', 'Cookie store']);
  assert.deepEqual(plansView(groups(), SHOWN).plans[0].issues, []);
});

test('an issue in a plan never shows under Not in a plan', () => {
  /* Given */
  const options = SHOWN;

  /* When */
  const view = plansView(groups(), options);

  /* Then */
  assert.deepEqual(view.loose.map(row => row.issue.number).sort(), [100, 101, 102]);
});

test('Show closed adds the closed plans, after the open ones', () => {
  /* Given */
  const options = { ...SHOWN, showClosed: true };

  /* When */
  const view = plansView(groups(), options);

  /* Then */
  assert.deepEqual(view.plans.map(p => p.plan.plan.title), ['Login rework', 'Move to Postgres']);
});

test('the issues not in a plan stop at eight until Show N more', () => {
  /* Given */
  const many = groups(overview(LOOSE_SHOWN + 4));

  /* When */
  const capped = plansView(many, SHOWN);
  const all = plansView(many, { ...SHOWN, looseExpanded: true });

  /* Then */
  assert.equal(capped.loose.length, LOOSE_SHOWN);
  assert.equal(capped.hiddenLoose, 4);
  assert.equal(all.loose.length, LOOSE_SHOWN + 4);
  assert.equal(all.hiddenLoose, 0);
});

test('the filter keeps a plan for its own title, or for its matching issues, shown expanded', () => {
  /* Given */
  const byPlan = { ...SHOWN, filter: 'login' };
  const byIssue = { ...SHOWN, filter: 'remember' };

  /* When */
  const planMatch = plansView(groups(), byPlan);
  const issueMatch = plansView(groups(), byIssue);

  /* Then */
  assert.deepEqual(planMatch.plans.map(p => [p.plan.plan.title, p.expanded]), [['Login rework', false]]);
  assert.deepEqual(planMatch.loose, []);
  assert.deepEqual(issueMatch.plans.map(p => [p.plan.plan.title, p.expanded, titles(p.issues)]), [['Login rework', true, ['Remember me']]]);
});

test('the filter finds loose issues by number, title or label, every word ignoring case', () => {
  /* Given */
  const view = (filter: string) => plansView(groups(), { ...SHOWN, filter }).loose.map(row => row.issue.number);

  /* When */
  const results = [view('#101'), view('LOOSE 102'), view('bug')];

  /* Then */
  assert.deepEqual(results, [[101], [102], [100]]);
  assert.equal(matchesFilter('anything', '  '), true);
});

test('the progress bar marks closed issues, then the next open one, and greys the rest', () => {
  /* Given */
  const login = groups().plans[0];

  /* When */
  const segments = progressSegments(login);

  /* Then */
  assert.deepEqual(segments, ['closed', 'next', 'rest', 'rest']);
  assert.equal(runningCount(login), 1);
});

test('a plan with nothing behind its view state answers no rows until there is an answer', () => {
  /* Given */
  const state = opened().projectPage;

  /* When */
  const before = plansViewOf(state, APP);
  const after = plansViewOf(run(opened(), { type: 'projectOverviewAnswered', projectPath: APP, closed: false, merged: false, overview: overview() }).projectPage, APP);

  /* Then */
  assert.equal(before, null);
  assert.ok(after);
});

// ── The cursor's rows and the keys ──

function rowsFor(options: PlansViewOptions, sessions: string[] = ['s1', 's2']): PageRow[] {
  return pageRows({ plans: planRows(plansView(groups(overview(LOOSE_SHOWN + 1)), options)), sessions: sessionRows(sessions) });
}

const EXPANDED = { ...SHOWN, expandedPlans: [REPO + '#10'] };

test('the cursor walks every row: plans, their issues, the loose ones, Show N more, then the sessions', () => {
  /* Given */
  const rows = rowsFor(EXPANDED);

  /* When */
  const ids = rows.map(row => row.id);

  /* Then */
  assert.deepEqual(ids.slice(0, 6), ['plan:acme/app#10', 'issue:acme/app#12', 'issue:acme/app#13', 'issue:acme/app#14', 'issue:acme/app#11', 'issue:acme/app#100']);
  assert.deepEqual(ids.slice(-3), [cursorId.moreLoose, 'session:s1', 'session:s2']);
});

test('↓ from the last plan row goes on into the next section, and ↑ comes back', () => {
  /* Given */
  const rows = rowsFor(SHOWN);
  const lastLoose = rows[rows.length - 4].id;

  /* When */
  const down = pageKeyAction('ArrowDown', rows, cursorId.moreLoose);
  const up = pageKeyAction('ArrowUp', rows, cursorId.moreLoose);

  /* Then */
  assert.deepEqual(down, { kind: 'cursor', target: 'session:s1' });
  assert.deepEqual(up, { kind: 'cursor', target: lastLoose });
  assert.deepEqual(pageKeyAction('ArrowDown', rows, null), { kind: 'cursor', target: 'plan:acme/app#10' });
});

test('→ expands a collapsed plan, and does nothing on an expanded one or an issue', () => {
  /* Given */
  const collapsed = rowsFor(SHOWN);
  const expanded = rowsFor(EXPANDED);

  /* When */
  const actions = [
    pageKeyAction('ArrowRight', collapsed, 'plan:acme/app#10'),
    pageKeyAction('ArrowRight', expanded, 'plan:acme/app#10'),
    pageKeyAction('ArrowRight', expanded, 'issue:acme/app#12'),
  ];

  /* Then */
  assert.deepEqual(actions, [{ kind: 'expand', plan: REPO + '#10' }, null, null]);
});

test('← collapses an expanded plan, and on one of its issues goes up to the plan', () => {
  /* Given */
  const rows = rowsFor(EXPANDED);

  /* When */
  const onPlan = pageKeyAction('ArrowLeft', rows, 'plan:acme/app#10');
  const onIssue = pageKeyAction('ArrowLeft', rows, 'issue:acme/app#13');
  const onLoose = pageKeyAction('ArrowLeft', rows, 'issue:acme/app#100');

  /* Then */
  assert.deepEqual(onPlan, { kind: 'collapse', plan: REPO + '#10' });
  assert.deepEqual(onIssue, { kind: 'cursor', target: 'plan:acme/app#10' });
  assert.equal(onLoose, null);
});

test('↵ opens what is under the cursor: a plan in the page, an issue on GitHub, a session, Show N more', () => {
  /* Given */
  const rows = rowsFor(EXPANDED);

  /* When */
  const actions = ['plan:acme/app#10', 'issue:acme/app#12', 'issue:acme/app#100', cursorId.moreLoose, 'session:s2']
    .map(cursor => pageKeyAction('Enter', rows, cursor));

  /* Then */
  assert.deepEqual(actions, [
    { kind: 'open-plan', plan: { repository: REPO, number: 10 } },
    { kind: 'open-issue', issue: { repository: REPO, number: 12 } },
    { kind: 'open-issue', issue: { repository: REPO, number: 100 } },
    { kind: 'show-more-loose' },
    { kind: 'open-session', sessionId: 's2' },
  ]);
  assert.equal(pageKeyAction('Enter', rows, null), null);
});

test('S starts a session only on a startable issue in a plan', () => {
  /* Given */
  const rows = rowsFor(EXPANDED);

  /* When */
  const ready = pageKeyAction('s', rows, 'issue:acme/app#13');
  const owned = pageKeyAction('s', rows, 'issue:acme/app#12');
  const waiting = pageKeyAction('s', rows, 'issue:acme/app#14');
  const onPlan = pageKeyAction('s', rows, 'plan:acme/app#10');

  /* Then */
  assert.deepEqual(ready, { kind: 'start', issue: { repository: REPO, number: 13 }, plan: { repository: REPO, number: 10 } });
  assert.deepEqual([owned, waiting, onPlan], [null, null, null]);
});

test('/ opens the filter wherever the cursor is', () => {
  /* Given */
  const rows = rowsFor(SHOWN);

  /* When */
  const action = pageKeyAction('/', rows, null);

  /* Then */
  assert.deepEqual(action, { kind: 'filter' });
});

// ── The recent list ──

test('opening a plan puts it first in its project’s recent list', () => {
  /* Given */
  const recent = { '/p': [REPO + '#1', REPO + '#2'] };

  /* When */
  const next = rememberPlan(recent, '/p', { repository: REPO, number: 3 });

  /* Then */
  assert.deepEqual(next['/p'], [REPO + '#3', REPO + '#1', REPO + '#2']);
});

test('opening a plan again moves it to the front rather than listing it twice', () => {
  /* Given */
  const recent = { '/p': [REPO + '#1', REPO + '#2', REPO + '#3'] };

  /* When */
  const next = rememberPlan(recent, '/p', { repository: REPO, number: 2 });

  /* Then */
  assert.deepEqual(next['/p'], [REPO + '#2', REPO + '#1', REPO + '#3']);
});

test('the recent list keeps the last ten per project, and other projects’ lists alone', () => {
  /* Given */
  const full = Array.from({ length: RECENT_PLANS_CAP }, (_, i) => REPO + '#' + (i + 1));
  const recent = { '/p': full, '/q': [REPO + '#7'] };

  /* When */
  const next = rememberPlan(recent, '/p', { repository: REPO, number: 50 });

  /* Then */
  assert.equal(RECENT_PLANS_CAP, 10);
  assert.equal(next['/p'].length, RECENT_PLANS_CAP);
  assert.equal(next['/p'][0], REPO + '#50');
  assert.ok(!next['/p'].includes(REPO + '#' + RECENT_PLANS_CAP));
  assert.deepEqual(next['/q'], [REPO + '#7']);
});

test('a stored recent list reads back; anything unreadable reads as none', () => {
  /* Given */
  const stored = JSON.stringify({ '/p': [REPO + '#1', 4, REPO + '#2'], '/q': 'nope' });

  /* When */
  const read = parseRecentPlans(stored);

  /* Then */
  assert.deepEqual(read, { '/p': [REPO + '#1', REPO + '#2'] });
  assert.deepEqual(parseRecentPlans('{not json'), {});
  assert.deepEqual(parseRecentPlans(null), {});
  assert.deepEqual(parseRecentPlans('[1,2]'), {});
});

test('the page opens with the plan viewed last expanded, beside the ones it remembered', () => {
  /* Given */
  const memory = { expandedPlans: [REPO + '#1'], showClosed: false };

  /* When */
  const withLatest = withRecentPlan(memory, [REPO + '#5', REPO + '#1']);
  const already = withRecentPlan(memory, [REPO + '#1']);
  const none = withRecentPlan(memory, []);

  /* Then */
  assert.deepEqual(withLatest.expandedPlans, [REPO + '#1', REPO + '#5']);
  assert.equal(already, memory);
  assert.equal(none, memory);
});

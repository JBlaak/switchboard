import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layOutPlan } from '../src/domain/plan/layout';
import { issueKeyString, type IssueKey, type Plan, type PlanIssue, type PlanPullRequest } from '../src/domain/plan/model';

const REPO = 'JBlaak/James';

function key(number: number, repository = REPO): IssueKey {
  return { repository, number };
}

function pr(number: number, state: PlanPullRequest['state'], draft = false): PlanPullRequest {
  return { number, state, draft, additions: 1, deletions: 1, headRef: 'branch-' + number, baseRef: 'main' };
}

function issue(number: number, fields: Partial<PlanIssue> = {}): PlanIssue {
  return {
    repository: REPO, number, title: 'Issue ' + number, state: 'open', closedAs: null,
    updatedAt: '2026-10-17T00:00:00Z', blockedBy: [], pullRequests: [], summary: '', acceptance: [],
    ...fields,
  };
}

function merged(number: number, blockedBy: number[] = []): PlanIssue {
  return issue(number, {
    state: 'closed', closedAs: 'completed', blockedBy: blockedBy.map((n) => key(n)), pullRequests: [pr(number + 100, 'merged')],
  });
}

function plan(issues: PlanIssue[], outside: PlanIssue[] = []): Plan {
  return { repository: REPO, number: 1, title: 'Epic', parent: null, issues, outside };
}

/** James #22's real "Blocked by" links: sub-issue → the issues it waits on. */
const JAMES_LINKS: Record<number, number[]> = {
  24: [], 25: [24], 26: [24], 27: [26], 28: [27], 29: [26], 30: [26], 31: [30], 32: [26], 33: [26],
  34: [33, 28], 35: [30, 34], 36: [24], 37: [36, 26], 38: [28, 37], 39: [37], 40: [30, 29, 27, 37],
  41: [28, 40, 38], 42: [31, 37], 43: [29, 39, 42], 44: [32, 37], 45: [37], 46: [30, 28, 39, 45],
  47: [46], 48: [40, 33, 44],
};

function jamesPlan(): Plan {
  return plan(Object.entries(JAMES_LINKS).map(([n, blockers]) => Number(n) === 25
    ? issue(25, { blockedBy: [key(24)] })
    : merged(Number(n), blockers)));
}

const numbers = (row: IssueKey[]) => row.map((k) => k.number).sort((a, b) => a - b);

test('James #22 lays out as six levels with #25 on Level 2, which is current', () => {
  /* Given */
  const james = jamesPlan();

  /* When */
  const layout = layOutPlan(james);

  /* Then */
  assert.deepEqual(layout.levels.map(numbers), [
    [24],
    [25, 26, 36],
    [27, 29, 30, 32, 33, 37],
    [28, 31, 39, 40, 44, 45],
    [34, 38, 42, 46, 48],
    [35, 41, 43, 47],
  ]);
  assert.equal(layout.levelOf(key(25)), 2);
  assert.equal(layout.current, 2);
  assert.equal(layout.stateOf(key(25)), 'ready');
  assert.equal(layout.stateOf(key(24)), 'merged');
  assert.deepEqual(layout.warnings, []);
});

test('#112\'s shape is one level that warns no-links and closed-without-pr', () => {
  /* Given */
  const repo = 'JBlaak/switchboard';
  const closedNoPr = (n: number) => issue(n, { repository: repo, state: 'closed', closedAs: 'completed' });
  const open = (n: number) => issue(n, { repository: repo });
  const epic = plan([closedNoPr(113), open(114), closedNoPr(115), open(116)]);

  /* When */
  const layout = layOutPlan(epic);

  /* Then */
  assert.deepEqual(layout.levels.map(numbers), [[113, 114, 115, 116]]);
  assert.equal(layout.current, 1);
  assert.deepEqual(layout.warnings, [
    { kind: 'no-links' },
    { kind: 'closed-without-pr', issue: key(113, repo) },
    { kind: 'closed-without-pr', issue: key(115, repo) },
  ]);
  assert.equal(layout.stateOf(key(113, repo)), 'closed');
  assert.equal(layout.stateOf(key(114, repo)), 'ready');
});

test('a single issue does not warn no-links', () => {
  /* Given */
  const lone = plan([issue(2)]);

  /* When */
  const layout = layOutPlan(lone);

  /* Then */
  assert.deepEqual(layout.warnings, []);
});

test('a not-planned issue does not warn, and still unblocks its dependents', () => {
  /* Given */
  const notPlanned = issue(2, { state: 'closed', closedAs: 'not_planned' });
  const dependent = issue(3, { blockedBy: [key(2)] });

  /* When */
  const layout = layOutPlan(plan([notPlanned, dependent]));

  /* Then */
  assert.equal(layout.stateOf(key(2)), 'not-planned');
  assert.equal(layout.stateOf(key(3)), 'ready');
  assert.equal(layout.current, 2);
  assert.deepEqual(layout.warnings, []);
});

test('a closed issue whose only PR closed unmerged warns closed-without-pr', () => {
  /* Given */
  const closed = issue(2, { state: 'closed', closedAs: 'completed', pullRequests: [pr(9, 'closed')] });

  /* When */
  const layout = layOutPlan(plan([closed]));

  /* Then */
  assert.equal(layout.stateOf(key(2)), 'closed');
  assert.deepEqual(layout.warnings, [{ kind: 'closed-without-pr', issue: key(2) }]);
});

test('an open outside blocker locks its dependent and is its ghost, without adding a level', () => {
  /* Given */
  const elsewhere = issue(7, { repository: 'JBlaak/other', title: 'Elsewhere' });
  const dependent = issue(2, { blockedBy: [key(7, 'JBlaak/other')] });
  const free = issue(3);

  /* When */
  const layout = layOutPlan(plan([dependent, free], [elsewhere]));

  /* Then */
  assert.equal(layout.stateOf(key(2)), 'locked');
  assert.deepEqual(layout.ghosts(key(2)), [elsewhere]);
  assert.deepEqual(layout.ghosts(key(3)), []);
  assert.deepEqual(layout.levels.map(numbers), [[2, 3]]);
  assert.equal(layout.stateOf(key(7, 'JBlaak/other')), 'ready');
});

test('a closed outside blocker leaves its dependent ready', () => {
  /* Given */
  const elsewhere = issue(7, { repository: 'JBlaak/other', state: 'closed', closedAs: 'completed' });
  const dependent = issue(2, { blockedBy: [key(7, 'JBlaak/other')] });

  /* When */
  const layout = layOutPlan(plan([dependent], [elsewhere]));

  /* Then */
  assert.equal(layout.stateOf(key(2)), 'ready');
});

test('a blocker that is neither in the plan nor outside is ignored', () => {
  /* Given */
  const dependent = issue(2, { blockedBy: [key(99)] });

  /* When */
  const layout = layOutPlan(plan([dependent]));

  /* Then */
  assert.equal(layout.levelOf(key(2)), 1);
  assert.equal(layout.stateOf(key(2)), 'ready');
  assert.deepEqual(layout.ghosts(key(2)), []);
});

test('the same number in another repository is a different issue', () => {
  /* Given */
  const blocker = issue(2);
  const dependent = issue(3, { blockedBy: [key(2, 'someone/else')] });

  /* When */
  const layout = layOutPlan(plan([blocker, dependent]));

  /* Then */
  assert.equal(layout.levelOf(key(3)), 1);
  assert.equal(layout.levelOf(key(2, 'someone/else')), 0);
});

test('open issues take their state from their PRs before their blockers', () => {
  /* Given */
  const blocker = issue(2);
  const review = issue(3, { blockedBy: [key(2)], pullRequests: [pr(10, 'open', true), pr(11, 'open')] });
  const draft = issue(4, { blockedBy: [key(2)], pullRequests: [pr(12, 'open', true)] });
  const locked = issue(5, { blockedBy: [key(2)], pullRequests: [pr(13, 'closed')] });

  /* When */
  const layout = layOutPlan(plan([blocker, review, draft, locked]));

  /* Then */
  assert.equal(layout.stateOf(key(2)), 'ready');
  assert.equal(layout.stateOf(key(3)), 'review');
  assert.equal(layout.stateOf(key(4)), 'draft');
  assert.equal(layout.stateOf(key(5)), 'locked');
});

test('a straggler holds the current level even when a later level has cleared', () => {
  /* Given */
  const straggler = issue(2);
  const first = merged(3);
  const later = merged(4, [3]);

  /* When */
  const layout = layOutPlan(plan([straggler, first, later]));

  /* Then */
  assert.equal(layout.current, 1);
});

test('a plan with no open issue is cleared', () => {
  /* Given */
  const done = plan([merged(2), merged(3, [2])]);

  /* When */
  const layout = layOutPlan(done);

  /* Then */
  assert.equal(layout.current, null);
});

test('rows put a child under the average position of its blockers, ties by number', () => {
  /* Given */
  // Level 1: 10, 11, 12, 13 at x = 0, 1, 2, 3.
  const top = [10, 11, 12, 13].map((n) => issue(n));
  const underRight = issue(20, { blockedBy: [key(12), key(13)] }); // average 2.5
  const underLeft = issue(21, { blockedBy: [key(10)] }); // average 0
  const underMiddle = issue(22, { blockedBy: [key(10), key(13)] }); // average 1.5
  const tieLow = issue(23, { blockedBy: [key(11), key(12)] }); // average 1.5, higher number

  /* When */
  const layout = layOutPlan(plan([underRight, underMiddle, tieLow, underLeft, ...top.reverse()]));

  /* Then */
  assert.deepEqual(layout.levels.map((row) => row.map((k) => k.number)), [
    [10, 11, 12, 13],
    [21, 22, 23, 20],
  ]);
});

test('unlocks lists the plan issues that wait on an issue, in row order', () => {
  /* Given */
  const james = jamesPlan();

  /* When */
  const layout = layOutPlan(james);

  /* Then */
  assert.deepEqual(layout.unlocks(key(24)).map((k) => k.number).sort((a, b) => a - b), [25, 26, 36]);
  assert.deepEqual(layout.unlocks(key(47)), []);
  const rowOrder = layout.levels.flat().map(issueKeyString);
  const unlocked = layout.unlocks(key(37)).map(issueKeyString);
  assert.deepEqual(unlocked, [...unlocked].sort((a, b) => rowOrder.indexOf(a) - rowOrder.indexOf(b)));
});

test('a link cycle does not hang and puts the cycle where it would sit without it', () => {
  /* Given */
  const root = issue(2);
  const a = issue(3, { blockedBy: [key(2), key(4)] });
  const b = issue(4, { blockedBy: [key(3)] });

  /* When */
  const layout = layOutPlan(plan([root, a, b]));

  /* Then */
  assert.equal(layout.levels.flat().length, 3);
  assert.equal(layout.levelOf(key(2)), 1);
  assert.equal(layout.levelOf(key(3)), 2);
  assert.ok(layout.levelOf(key(4)) >= 1);
  assert.deepEqual(layout.warnings, []);
});

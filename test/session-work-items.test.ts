import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveWorkItems, isDone, workItemKey, type WorkFacts } from '../src/domain/session-work/items';
import type { Activity, PullRequestStatus, WorkItem, WorkLocation } from '../src/domain/session-work/model';

const REPO = 'owner/repo';
const MAIN = '/repo';
const AGENT = '/repo/.claude/worktrees/agent-1';
const url = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const link = (n: number) => ({ number: n, url: url(n), repository: REPO });

function facts(overrides: Partial<WorkFacts>): WorkFacts {
  return {
    locations: [], pullRequests: [], branches: [], changes: [], github: null,
    issueMentions: [], repository: REPO, ...overrides,
  };
}

function gh(n: number, more: Partial<PullRequestStatus>): PullRequestStatus {
  return { ...link(n), closes: [], state: 'open', ...more };
}

const loc = (worktree: string, branch: string, fromSubagent = false): WorkLocation => ({ worktree, branch, fromSubagent });

/** A compact picture of the list: kind plus what identifies it. */
function summary(items: WorkItem[]): string[] {
  return items.map((item) => {
    switch (item.kind) {
      case 'pr': return `pr #${item.pr.number}`;
      case 'branch': return `branch ${item.location.branch}`;
      case 'dirty': return `dirty ${item.location.worktree}`;
      case 'issue': return `issue #${item.issue.number}`;
    }
  });
}

test('nothing yet is no items', () => {
  assert.deepEqual(deriveWorkItems(facts({})), []);
});

test('without gh, PRs come from the transcript alone, newest first, diffed through gh', () => {
  const items = deriveWorkItems(facts({ pullRequests: [link(1), link(2), link(1)] }));
  assert.deepEqual(summary(items), ['pr #2', 'pr #1']);
  const [first] = items;
  assert.ok(first.kind === 'pr');
  assert.deepEqual(first.pr, { ...link(2), closes: [] });
  assert.equal(first.location, null);
  assert.deepEqual(first.diff, { kind: 'pull-request', repository: REPO, number: 2 });
});

test('the default branch is never a branch item, though it can be dirty', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(MAIN, 'main')],
    branches: [{ worktree: MAIN, branch: 'main', isDefault: true, ahead: 3, base: 'origin/main', additions: 0, deletions: 0, pushed: true }],
    changes: [{ worktree: MAIN, branch: 'main', files: [{ path: 'a.ts', status: 'modified' }], additions: 0, deletions: 0 }],
  }));
  assert.deepEqual(summary(items), [`dirty ${MAIN}`]);
  assert.ok(items[0].kind === 'dirty');
  assert.deepEqual(items[0].location, loc(MAIN, 'main'));
});

test('a branch with commits and no PR is an item, diffed locally; one with no commits is not', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'feat/a', true), loc(AGENT, 'feat/empty', true)],
    branches: [
      { worktree: AGENT, branch: 'feat/a', isDefault: false, ahead: 2, base: 'origin/main', additions: 10, deletions: 2, pushed: false },
      { worktree: AGENT, branch: 'feat/empty', isDefault: false, ahead: 0, base: 'origin/main', additions: 0, deletions: 0, pushed: true },
    ],
  }));
  assert.deepEqual(items, [{
    kind: 'branch',
    location: loc(AGENT, 'feat/a', true),
    ahead: 2,
    diff: { kind: 'local', worktree: AGENT, base: 'origin/main', head: 'feat/a' },
    activity: null,
    additions: 10,
    deletions: 2,
    pushed: false,
  }]);
});

test('a branch that heads a PR becomes part of that PR\'s item', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'feat/a', true), loc(MAIN, 'feat/a')],
    pullRequests: [link(5)],
    github: [gh(5, { headRef: 'feat/a', baseRef: 'develop', title: 'A' })],
    branches: [
      { worktree: AGENT, branch: 'feat/a', isDefault: false, ahead: 2, base: 'origin/main', additions: 0, deletions: 0, pushed: true },
      { worktree: MAIN, branch: 'feat/a', isDefault: false, ahead: 2, base: 'origin/main', additions: 0, deletions: 0, pushed: true },
    ],
  }));
  assert.deepEqual(summary(items), ['pr #5']);
  const [pr] = items;
  assert.ok(pr.kind === 'pr');
  assert.equal(pr.pr.title, 'A');
  // The main conversation's checkout wins over the subagent's.
  assert.deepEqual(pr.location, loc(MAIN, 'feat/a'));
  assert.deepEqual(pr.diff, { kind: 'local', worktree: MAIN, base: 'origin/develop', head: 'feat/a' });
});

test('without gh a branch cannot be matched to its PR, so both show', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'feat/a')],
    pullRequests: [link(5)],
    branches: [{ worktree: AGENT, branch: 'feat/a', isDefault: false, ahead: 1, base: 'origin/main', additions: 0, deletions: 0, pushed: true }],
  }));
  assert.deepEqual(summary(items), ['pr #5', 'branch feat/a']);
});

test('only branches and worktrees the transcripts name are looked at', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(MAIN, 'main')],
    branches: [{ worktree: '/other', branch: 'feat/x', isDefault: false, ahead: 4, base: 'origin/main', additions: 0, deletions: 0, pushed: true }],
    changes: [{ worktree: '/other', branch: 'feat/x', files: [{ path: 'a', status: 'untracked' }], additions: 0, deletions: 0 }],
  }));
  assert.deepEqual(items, []);
});

test('duplicates are dropped by URL and by worktree and branch', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'feat/a'), loc(AGENT, 'feat/a', true), loc(AGENT, 'feat/b')],
    pullRequests: [link(1), link(1)],
    github: [gh(1, {}), gh(1, { title: 'second' })],
    branches: [
      { worktree: AGENT, branch: 'feat/a', isDefault: false, ahead: 1, base: 'origin/main', additions: 0, deletions: 0, pushed: true },
      { worktree: AGENT, branch: 'feat/a', isDefault: false, ahead: 9, base: 'origin/main', additions: 0, deletions: 0, pushed: true },
    ],
    changes: [
      { worktree: AGENT, branch: 'feat/b', files: [{ path: 'x', status: 'modified' }], additions: 0, deletions: 0 },
      { worktree: AGENT, branch: 'feat/b', files: [{ path: 'y', status: 'modified' }], additions: 0, deletions: 0 },
    ],
  }));
  assert.deepEqual(summary(items), ['pr #1', 'branch feat/a', `dirty ${AGENT}`]);
  assert.ok(items[1].kind === 'branch' && items[1].ahead === 1);
  assert.ok(items[2].kind === 'dirty');
  assert.deepEqual(items[2].files, [{ path: 'x', status: 'modified' }]);
  assert.deepEqual(items[2].location, loc(AGENT, 'feat/b'));
});

test('a dirty worktree on a branch the transcripts never named still shows', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'feat/a', true)],
    changes: [{ worktree: AGENT, branch: 'feat/c', files: [{ path: 'x', status: 'added' }], additions: 1, deletions: 0 }],
  }));
  assert.deepEqual(items, [{ kind: 'dirty', location: loc(AGENT, 'feat/c', true), files: [{ path: 'x', status: 'added' }], additions: 1, deletions: 0 }]);
});

test('issues: mentions and branch names, minus what a PR closes and the PRs themselves', () => {
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'fix/44-thing')],
    pullRequests: [link(50)],
    github: [gh(50, { closes: [{ repository: REPO, number: 10 }] })],
    issueMentions: [
      { repository: REPO, number: 10 },
      { repository: REPO, number: 11 },
      { repository: REPO, number: 50 },
    ],
  }));
  assert.deepEqual(summary(items), ['pr #50', 'issue #11', 'issue #44']);
});

test('the list is ordered: open PRs (needs-you first, then newest), branches, dirty, issues, done', () => {
  const gaveUp: Activity = { id: 'a1', action: 'fix-ci', phase: 'gave-up', origin: 'auto', attempt: 2, queuedAt: '2026-01-01T00:00:00Z' };
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'feat/x'), loc(MAIN, 'main')],
    pullRequests: [link(1), link(2), link(3), link(4), link(5), link(6)],
    github: [
      gh(1, { state: 'merged' }),
      gh(2, { state: 'open' }),
      gh(3, { state: 'draft', threads: [{ id: 't', path: 'a', line: 1, side: 'RIGHT', resolved: false, needsYou: true, comments: [] }] }),
      gh(4, { state: 'closed' }),
      gh(5, { state: 'open' }),
      gh(6, { state: 'open' }),
    ],
    branches: [{ worktree: AGENT, branch: 'feat/x', isDefault: false, ahead: 1, base: 'origin/main', additions: 0, deletions: 0, pushed: true }],
    changes: [{ worktree: MAIN, branch: 'main', files: [{ path: 'a', status: 'modified' }], additions: 0, deletions: 0 }],
    issueMentions: [{ repository: REPO, number: 99 }],
    activities: new Map([[`pr:${url(2)}`, gaveUp]]),
  }));
  assert.deepEqual(summary(items), [
    'pr #3', 'pr #2', 'pr #6', 'pr #5',
    'branch feat/x', `dirty ${MAIN}`, 'issue #99',
    'pr #4', 'pr #1',
  ]);
  assert.deepEqual(items.map(isDone), [false, false, false, false, false, false, false, true, true]);
  const two = items[1];
  assert.ok(two.kind === 'pr');
  assert.equal(two.activity, gaveUp);
});

test('activities attach to branches by their key', () => {
  const opening: Activity = { id: 'a2', action: 'open-pr', phase: 'sent', origin: 'manual', queuedAt: '2026-01-01T00:00:00Z' };
  const items = deriveWorkItems(facts({
    locations: [loc(AGENT, 'feat/a')],
    branches: [{ worktree: AGENT, branch: 'feat/a', isDefault: false, ahead: 1, base: 'origin/main', additions: 0, deletions: 0, pushed: true }],
    activities: new Map([[`branch:${AGENT}\0feat/a`, opening]]),
  }));
  assert.ok(items[0].kind === 'branch');
  assert.equal(items[0].activity, opening);
  assert.equal(workItemKey(items[0]), `branch:${AGENT}\0feat/a`);
});

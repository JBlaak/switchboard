import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_REFRESH_MS, LOCAL_DIFFERS, SHIP_REFRESH_MS, SessionWorkService, WATCH_DEBOUNCE_MS, type SessionWorkTarget,
} from '../src/application/services/session-work-service';
import type { SessionActivities } from '../src/application/services/session-action-service';
import { canComment } from '../src/domain/session-work/review';
import type { Timers } from '../src/application/ports/clock';
import type { GitWorkspace } from '../src/application/ports/git-workspace';
import type { GitHubAvailability, GitHubCli } from '../src/application/ports/github-cli';
import type { TranscriptLocation } from '../src/application/ports/transcript-store';
import type { Session, SessionPullRequest } from '../src/domain/session/session';
import type {
  FileChange, IssueRef, IssueStatus, LineStats, PullRequestStatus, SessionWorkSnapshot,
} from '../src/domain/session-work/model';
import { silentLog } from './support/fakes';

const ROOT = '/code/app';
const AGENT = '/code/app/.claude/worktrees/agent-1';
const REPO = 'o/app';

const DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1 @@',
  '-one',
  '+two',
  '',
].join('\n');

function prLink(number: number): SessionPullRequest {
  return { number, url: `https://github.com/${REPO}/pull/${number}`, repository: REPO };
}

function prStatus(number: number, extra: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number, url: `https://github.com/${REPO}/pull/${number}`, repository: REPO,
    state: 'open', baseRef: 'main', headSha: 'head-' + number, closes: [], ...extra,
  };
}

/** Timers whose timeouts and intervals are fired by hand. */
function manualTimers() {
  let seq = 0;
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timers: Timers & {
    timeouts: typeof timeouts; intervals: typeof intervals;
    fireTimeouts(): void; fireIntervals(): void;
  } = {
    timeouts, intervals,
    setTimeout(fn, ms) { timeouts.set(++seq, { fn, ms }); return seq; },
    clearTimeout(handle) { if (handle != null) timeouts.delete(handle as number); },
    setInterval(fn, ms) { intervals.set(++seq, { fn, ms }); return seq; },
    clearInterval(handle) { if (handle != null) intervals.delete(handle as number); },
    fireTimeouts() {
      for (const [id, { fn }] of [...timeouts]) { timeouts.delete(id); fn(); }
    },
    fireIntervals() {
      for (const { fn } of [...intervals.values()]) fn();
    },
  };
  return timers;
}

interface World {
  /** cwd → worktree root; anything missing is in no repository. */
  roots: Map<string, string>;
  branches: Set<string>;
  current: Map<string, string>;
  status: Map<string, FileChange[]>;
  ahead: Map<string, number>;
  shas: Map<string, string>;
  branchDiff: string;
  workingDiff: string;
  /** Line stats by branch, and of each worktree's uncommitted changes. */
  /** Branches with an upstream or a copy on origin. */
  pushed: Set<string>;
  branchStats: Map<string, LineStats>;
  workingStats: Map<string, LineStats>;
  generated: string[];
  locations: TranscriptLocation[];
  pullRequests: SessionPullRequest[];
  mentions: IssueRef[];
  gh: GitHubAvailability;
  prs: PullRequestStatus[] | null;
  prDiff: string | null;
  issues: IssueStatus[] | null;
  targets: Map<string, SessionWorkTarget>;
  /** What the action service says about the session's items. */
  activities: SessionActivities;
}

function setup(overrides: Partial<World> = {}) {
  const world: World = {
    roots: new Map([[ROOT, ROOT], [ROOT + '/src', ROOT], [ROOT + '/src/deep', ROOT], [AGENT, AGENT]]),
    branches: new Set(['main']),
    current: new Map([[ROOT, 'main'], [AGENT, 'feat/agent']]),
    status: new Map(),
    ahead: new Map(),
    shas: new Map([['origin/main', 'base-1']]),
    branchDiff: DIFF,
    workingDiff: DIFF,
    pushed: new Set(),
    branchStats: new Map(),
    workingStats: new Map(),
    generated: [],
    locations: [{ cwd: ROOT, branch: 'main', fromSubagent: false }],
    pullRequests: [],
    mentions: [],
    gh: 'ok',
    prs: [],
    prDiff: DIFF,
    issues: [],
    targets: new Map([
      ['s1', { folder: 'f1', projectPath: ROOT }],
      ['s2', { folder: 'f2', projectPath: ROOT }],
      ['remote', { folder: null, projectPath: 'ssh://me@host/dir' }],
      ['loose', { folder: 'f3', projectPath: '/tmp/not-a-repo' }],
    ]),
    activities: { byItem: new Map(), queued: 0, shipping: false },
    ...overrides,
  };

  const calls: Record<string, number> = {};
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const watchers: Array<{ worktree: string; onChange: () => void; disposed: boolean }> = [];

  const git: GitWorkspace = {
    async worktreeRoot(cwd) { count('worktreeRoot'); return world.roots.get(cwd) ?? null; },
    async defaultBranch() { return 'main'; },
    async currentBranch(worktree) { return world.roots.get(worktree) ? world.current.get(worktree) ?? null : null; },
    async commitSha(_worktree, ref) {
      if (world.shas.has(ref)) return world.shas.get(ref)!;
      return world.branches.has(ref) ? 'sha-' + ref : null;
    },
    async branchExists(_worktree, branch) { return world.branches.has(branch); },
    async isPushed(_worktree, branch) { return world.pushed.has(branch); },
    async aheadBehind(_worktree, branch) { return { ahead: world.ahead.get(branch) ?? 0, behind: 0 }; },
    async branchDiff() { count('branchDiff'); return world.branchDiff; },
    async status(worktree) { return world.status.get(worktree) ?? []; },
    async branchLineStats(_worktree, branch) { return world.branchStats.get(branch) ?? { additions: 0, deletions: 0 }; },
    async workingDiff() { count('workingDiff'); return world.workingDiff; },
    async workingLineStats(worktree) { return world.workingStats.get(worktree) ?? { additions: 0, deletions: 0 }; },
    async generatedPaths(_worktree, paths) { return paths.filter((p) => world.generated.includes(p)); },
    watch(worktree, onChange) {
      const watcher = { worktree, onChange, disposed: false };
      watchers.push(watcher);
      return { dispose() { watcher.disposed = true; } };
    },
  };

  const github: Omit<GitHubCli, 'startPendingReview' | 'addPendingComment' | 'deletePendingReview' | 'submitPendingReview'> = {
    async available() { count('available'); return world.gh; },
    async pullRequests() { count('pullRequests'); return world.prs; },
    async pullRequestDiff() { count('pullRequestDiff'); return world.prDiff; },
    async checkLogTail() { return null; },
    async issues() { count('issues'); return world.issues; },
  };

  const snapshots: SessionWorkSnapshot[] = [];
  const timers = manualTimers();
  let now = Date.UTC(2026, 9, 17, 12, 0, 0);

  const service = new SessionWorkService({
    locate: (sessionId) => world.targets.get(sessionId) ?? null,
    transcripts: {
      locations: () => world.locations,
      issueMentions: () => world.mentions,
      readSession: () => ({ pullRequests: world.pullRequests }) as unknown as Session,
    },
    git,
    github,
    remotes: { async originUrl() { return 'git@github.com:o/app.git'; } },
    renderer: { sessionWorkSnapshot: (snapshot) => snapshots.push(snapshot) },
    activities: { forSession: () => world.activities },
    clock: { now: () => (now += 1000) },
    timers,
    log: silentLog,
  });

  return {
    world, service, snapshots, timers, calls, watchers,
    live: () => watchers.filter((watcher) => !watcher.disposed),
    last: () => snapshots[snapshots.length - 1],
  };
}

/** Let every pending promise in the fakes run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ── Eligibility ──

test('canOpen is false for remote sessions, sessions outside a repository, and unknown ones', async () => {
  /* Given */
  const { service } = setup();
  const cases: [string, boolean][] = [['s1', true], ['remote', false], ['loose', false], ['nobody', false]];

  for (const [sessionId, expected] of cases) {
    /* When */
    const can = await service.canOpen(sessionId);

    /* Then */
    assert.equal(can, expected, sessionId);
  }
});

test('open answers null, and starts nothing, where canOpen is false', async () => {
  /* Given */
  const { service, snapshots, timers } = setup();

  /* When */
  const remote = await service.open('remote');
  const loose = await service.open('loose');

  /* Then */
  assert.equal(remote, null);
  assert.equal(loose, null);
  assert.deepEqual(snapshots, []);
  assert.equal(timers.intervals.size, 0);
});

// ── Snapshots ──

test('nothing changed yet: an empty snapshot, pushed once', async () => {
  /* Given */
  const { service, snapshots } = setup();

  /* When */
  const first = await service.open('s1');

  /* Then */
  assert.deepEqual(first?.items, []);
  assert.equal(first?.gh, 'ok');
  assert.equal(first?.sessionId, 's1');
  assert.equal(first?.repository, REPO, 'from the origin remote');
  assert.equal(snapshots.length, 1);
  assert.equal(typeof first?.updatedAt, 'string');
});

test('nothing changed yet: not pushed again when a rebuild finds the same', async () => {
  /* Given */
  const { service, snapshots, timers, live } = setup();
  await service.open('s1');

  /* When */
  live()[0].onChange();
  timers.fireTimeouts();
  await settle();
  timers.fireIntervals();
  await settle();

  /* Then */
  assert.equal(snapshots.length, 1, 'nothing new to push');
});

function subdirectorySetup() {
  const harness = setup({
    locations: [
      { cwd: ROOT + '/src', branch: 'feat/1-thing', fromSubagent: true },
      { cwd: ROOT + '/src/deep', branch: 'feat/1-thing', fromSubagent: false },
      { cwd: ROOT + '/src', branch: 'feat/1-thing', fromSubagent: true },
    ],
    branches: new Set(['main', 'feat/1-thing']),
    ahead: new Map([['feat/1-thing', 2]]),
    gh: 'missing',
  });
  harness.world.status.set(ROOT, [{ path: 'x.ts', status: 'modified' }]);
  return harness;
}

test('a cwd in a subdirectory resolves to its worktree root, and lines in one root merge into one place', async () => {
  /* Given */
  const { service, live } = subdirectorySetup();

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  const branch = snapshot!.items.find((item) => item.kind === 'branch');
  assert.ok(branch && branch.kind === 'branch');
  assert.deepEqual(branch.location, { worktree: ROOT, branch: 'feat/1-thing', fromSubagent: false });
  assert.equal(branch.ahead, 2);
  assert.equal(branch.id, 'branch:' + ROOT + '\0feat/1-thing');
  assert.deepEqual(live().map((watcher) => watcher.worktree), [ROOT], 'one watcher per worktree');
});

test('each cwd is resolved to its worktree root once', async () => {
  /* Given */
  const { service, world, calls } = subdirectorySetup();
  await service.open('s1');
  const before = calls.worktreeRoot;

  /* When */
  world.locations = [...world.locations];
  await service.open('s1');

  /* Then */
  // Each cwd is resolved once; only the root itself is checked again.
  assert.equal(calls.worktreeRoot - before, 1);
});

test('a subagent worktree is its own place, marked as the subagent\'s, and watched', async () => {
  /* Given */
  const { service, world, live } = setup({
    locations: [
      { cwd: ROOT, branch: 'main', fromSubagent: false },
      { cwd: AGENT, branch: 'feat/agent', fromSubagent: true },
    ],
    branches: new Set(['main', 'feat/agent']),
    ahead: new Map([['feat/agent', 1]]),
  });
  world.status.set(AGENT, [{ path: 'new.ts', status: 'untracked' }]);
  world.branchStats.set('feat/agent', { additions: 40, deletions: 7 });
  world.pushed.add('feat/agent');
  world.workingStats.set(AGENT, { additions: 3, deletions: 0 });

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  const kinds = snapshot!.items.map((item) => item.kind);
  assert.deepEqual(kinds, ['branch', 'dirty']);
  assert.deepEqual(snapshot!.items.map((item) => item.kind !== 'pr' && item.kind !== 'issue' && [item.additions, item.deletions]), [
    [40, 7],
    [3, 0],
  ], 'each item counts its own lines');
  assert.ok(snapshot!.items[0].kind === 'branch' && snapshot!.items[0].pushed, 'pushed');
  for (const item of snapshot!.items) {
    assert.ok(item.kind === 'branch' || item.kind === 'dirty');
    assert.deepEqual(item.location, { worktree: AGENT, branch: 'feat/agent', fromSubagent: true });
  }
  assert.deepEqual(live().map((watcher) => watcher.worktree).sort(), [AGENT, ROOT].sort());
});

test('a merged PR is listed under Done with what gh said about it', async () => {
  /* Given */
  const { service } = setup({
    pullRequests: [prLink(7), prLink(8)],
    prs: [prStatus(7, { state: 'merged', title: 'Old' }), prStatus(8, { title: 'New' })],
  });

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  assert.deepEqual(snapshot!.items.map((item) => item.kind === 'pr' && [item.pr.number, item.pr.state]), [
    [8, 'open'],
    [7, 'merged'],
  ]);
  assert.ok(snapshot!.items.every((item) => !item.error));
});

// A PR whose branch was deleted.
const deletedBranchPr = () => setup({
  pullRequests: [prLink(9)],
  prs: [prStatus(9, { headRef: 'feat/gone' })],
});

test('a PR whose branch was deleted takes its diff from gh', async () => {
  /* Given */
  const { service } = deletedBranchPr();

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  const pr = snapshot!.items[0];
  assert.ok(pr.kind === 'pr');
  assert.deepEqual(pr.diff, { kind: 'pull-request', repository: REPO, number: 9 });
});

test('a PR whose branch was deleted is diffed by GitHub', async () => {
  /* Given */
  const { service } = deletedBranchPr();
  const id = (await service.open('s1'))!.items[0].id;

  /* When */
  const fromGitHub = await service.diff('s1', id);

  /* Then */
  assert.equal(fromGitHub.source, 'github', 'the page says the branch is not checked out');
  const files = fromGitHub.files;
  assert.deepEqual(files.map((file) => [file.path, file.additions, file.deletions]), [['a.txt', 1, 1]]);
});

test('a PR diff from GitHub is cached by its head commit', async () => {
  /* Given */
  const { service, calls } = deletedBranchPr();
  const id = (await service.open('s1'))!.items[0].id;

  /* When */
  await service.diff('s1', id);
  await service.diff('s1', id);

  /* Then */
  assert.equal(calls.pullRequestDiff, 1, 'the second ask is cached');
});

test('a new head commit on GitHub is a new diff', async () => {
  /* Given */
  const { service, world, calls } = deletedBranchPr();
  const id = (await service.open('s1'))!.items[0].id;
  await service.diff('s1', id);
  await service.diff('s1', id);

  /* When */
  world.prs = [prStatus(9, { headRef: 'feat/gone', headSha: 'pushed-again' })];
  await service.open('s1');
  await service.diff('s1', id);

  /* Then */
  assert.equal(calls.pullRequestDiff, 2, 'a new head commit is a new diff');
});

// A PR whose branch is checked out.
const checkedOutBranchPr = () => setup({
  locations: [{ cwd: ROOT, branch: 'feat/3-x', fromSubagent: false }],
  branches: new Set(['main', 'feat/3-x']),
  pullRequests: [prLink(3)],
  prs: [prStatus(3, { headRef: 'feat/3-x', headSha: 'sha-feat/3-x' })],
  generated: ['a.txt'],
});

test('a PR whose branch is checked out diffs locally', async () => {
  /* Given */
  const { service } = checkedOutBranchPr();

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  const pr = snapshot!.items[0];
  assert.ok(pr.kind === 'pr');
  assert.deepEqual(pr.diff, { kind: 'local', worktree: ROOT, base: 'origin/main', head: 'feat/3-x' });
});

test('a local PR diff has generated files collapsed', async () => {
  /* Given */
  const { service } = checkedOutBranchPr();
  const id = (await service.open('s1'))!.items[0].id;

  /* When */
  const local = await service.diff('s1', id);

  /* Then */
  assert.equal(local.source, 'local');
  assert.equal(local.files[0].collapsedReason, 'generated');
});

test('a local PR diff is cached by both commits, and never asks GitHub', async () => {
  /* Given */
  const { service, calls } = checkedOutBranchPr();
  const id = (await service.open('s1'))!.items[0].id;

  /* When */
  await service.diff('s1', id);
  await service.diff('s1', id);

  /* Then */
  assert.equal(calls.branchDiff, 1);
  assert.equal(calls.pullRequestDiff, undefined);
});

test('a new commit on a checked-out PR branch is a new diff', async () => {
  /* Given */
  const { service, world, calls } = checkedOutBranchPr();
  const id = (await service.open('s1'))!.items[0].id;
  await service.diff('s1', id);
  await service.diff('s1', id);

  /* When */
  world.shas.set('feat/3-x', 'new-commit');
  world.prs = [prStatus(3, { headRef: 'feat/3-x', headSha: 'new-commit' })];
  await service.open('s1');
  await service.diff('s1', id);

  /* Then */
  assert.equal(calls.branchDiff, 2, 'a new commit on the branch is a new diff');
});

// ── A checked-out PR at another commit than GitHub's (#77) ──

function checkedOutPr(localSha: string, prSha: string) {
  return setup({
    locations: [{ cwd: ROOT, branch: 'feat/3-x', fromSubagent: false }],
    branches: new Set(['main', 'feat/3-x']),
    shas: new Map([['origin/main', 'base-1'], ['feat/3-x', localSha]]),
    pullRequests: [prLink(3)],
    prs: [prStatus(3, { headRef: 'feat/3-x', headSha: prSha })],
  });
}

test('a checked-out PR at GitHub\'s commit diffs locally, and takes comments', async () => {
  /* Given */
  const { service, calls } = checkedOutPr('abc', 'abc');
  const snapshot = await service.open('s1');
  const pr = snapshot!.items[0];

  /* When */
  const diff = await service.diff('s1', pr.id);

  /* Then */
  assert.ok(pr.kind === 'pr');
  assert.equal(diff.source, 'local');
  assert.equal(diff.note, undefined);
  assert.equal(calls.pullRequestDiff, undefined);
  assert.equal(canComment(pr, snapshot!.gh), true);
});

test('a checked-out PR at another commit shows GitHub\'s diff, says why, and comments go against it', async () => {
  /* Given */
  const { service, calls } = checkedOutPr('local-unpushed', 'abc');
  const snapshot = await service.open('s1');
  const pr = snapshot!.items[0];

  /* When */
  const diff = await service.diff('s1', pr.id);

  /* Then */
  assert.ok(pr.kind === 'pr');
  assert.equal(diff.source, 'github');
  assert.equal(diff.note, LOCAL_DIFFERS);
  assert.equal(calls.branchDiff, undefined, 'the local lines are never offered');
  assert.equal(calls.pullRequestDiff, 1);
  assert.deepEqual(diff.files.map((file) => file.path), ['a.txt']);
  assert.equal(canComment(pr, snapshot!.gh), true);
});

test('uncommitted changes are diffed fresh every time', async () => {
  /* Given */
  const { service, world, calls } = setup();
  world.status.set(ROOT, [{ path: 'a.txt', status: 'modified' }]);
  const snapshot = await service.open('s1');
  const dirty = snapshot!.items[0];

  /* When */
  await service.diff('s1', dirty.id);
  await service.diff('s1', dirty.id);

  /* Then */
  assert.equal(dirty.kind, 'dirty');
  assert.equal(calls.workingDiff, 2);
});

const withRemovedWorktrees = () => setup({
  locations: [
    { cwd: ROOT, branch: 'main', fromSubagent: false },
    { cwd: AGENT, branch: 'feat/agent', fromSubagent: true },
    { cwd: '/code/app/.claude/worktrees/removed-long-ago', branch: 'feat/old', fromSubagent: true },
  ],
  branches: new Set(['main', 'feat/agent']),
  ahead: new Map([['feat/agent', 1]]),
});

test('a worktree that is gone drops out, and is not watched', async () => {
  /* Given */
  const { service, live } = withRemovedWorktrees();

  /* When */
  const first = await service.open('s1');

  /* Then */
  assert.deepEqual(first!.items.map((item) => item.kind), ['branch']);
  assert.deepEqual(live().map((watcher) => watcher.worktree).sort(), [AGENT, ROOT].sort());
});

test('a worktree removed while the page is open drops its watcher on the next rebuild', async () => {
  /* Given */
  const { service, world, live, timers } = withRemovedWorktrees();
  await service.open('s1');

  /* When */
  // The agent's worktree is removed (its branch kept); the next rebuild drops it.
  world.roots.delete(AGENT);
  live().find((watcher) => watcher.worktree === AGENT)!.onChange();
  timers.fireTimeouts();
  await settle();

  /* Then */
  assert.deepEqual(live().map((watcher) => watcher.worktree), [ROOT]);
});

const withoutGh = (gh: 'missing' | 'unauthenticated') => setup({
  gh,
  pullRequests: [prLink(4)],
  prs: [prStatus(4, { state: 'merged' })],
});

test('without gh the page has git-only data, says why, and never asks GitHub for PRs', async () => {
  /* Given */
  const cases = ['missing', 'unauthenticated'] as const;

  for (const gh of cases) {
    const { service, calls } = withoutGh(gh);

    /* When */
    const snapshot = await service.open('s1');

    /* Then */
    assert.equal(snapshot!.gh, gh);
    const pr = snapshot!.items[0];
    assert.ok(pr.kind === 'pr');
    assert.equal(pr.pr.state, undefined, 'unknown, not merged');
    assert.equal(pr.error, undefined);
    assert.equal(calls.pullRequests, undefined);
    assert.equal(calls.issues, undefined);
  }
});

test('without gh a PR whose branch is not here has no diff, and the item says why', async () => {
  // Its branch is not here and gh cannot fetch it: no diff, and the item says why.
  /* Given */
  const cases = ['missing', 'unauthenticated'] as const;

  for (const gh of cases) {
    const { service, snapshots } = withoutGh(gh);
    const id = (await service.open('s1'))!.items[0].id;

    /* When */
    const none = await service.diff('s1', id);

    /* Then */
    assert.deepEqual([none.files, none.source], [[], null]);
    assert.match(none.error ?? '', gh === 'missing' ? /not installed/ : /not signed in/);
    const marked = snapshots[snapshots.length - 1].items[0];
    assert.equal(marked.error, none.error);
  }
});

test('a failed gh request marks its PRs, not the page', async () => {
  /* Given */
  const { service, world } = setup({
    pullRequests: [prLink(5)],
    prs: null,
  });
  world.status.set(ROOT, [{ path: 'a.txt', status: 'modified' }]);

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  assert.equal(snapshot!.gh, 'ok');
  const pr = snapshot!.items.find((item) => item.kind === 'pr')!;
  assert.match(pr.error ?? '', /GitHub did not answer/);
  const dirty = snapshot!.items.find((item) => item.kind === 'dirty')!;
  assert.equal(dirty.error, undefined);
});

test('issues gh confirms are listed with their title; a mention that is a PR drops out', async () => {
  /* Given */
  const { service } = setup({
    mentions: [{ repository: '', number: 12 }, { repository: '', number: 88 }],
    issues: [{ repository: REPO, number: 12, title: 'Bug', state: 'open', url: 'https://github.com/o/app/issues/12' }],
  });

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  assert.deepEqual(snapshot!.items.map((item) => item.kind === 'issue' && item.issue), [
    { repository: '', number: 12, title: 'Bug', state: 'open', url: 'https://github.com/o/app/issues/12' },
  ]);
});

// ── Watching ──

test('a burst of watcher events schedules one rebuild, after the debounce', async () => {
  /* Given */
  const { service, timers, live } = setup();
  await service.open('s1');
  const [watcher] = live();

  /* When */
  watcher.onChange();
  watcher.onChange();
  watcher.onChange();

  /* Then */
  assert.equal(timers.timeouts.size, 1);
  assert.equal([...timers.timeouts.values()][0].ms, WATCH_DEBOUNCE_MS);
});

test('a burst of watcher events rebuilds once', async () => {
  /* Given */
  const { service, world, timers, live, snapshots } = setup();
  await service.open('s1');
  const [watcher] = live();
  watcher.onChange();
  watcher.onChange();
  watcher.onChange();
  world.status.set(ROOT, [{ path: 'a.txt', status: 'modified' }]);

  /* When */
  timers.fireTimeouts();
  await settle();

  /* Then */
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].items[0].kind, 'dirty');
});

test('a write to another session\'s transcript folder does not rebuild the page', async () => {
  /* Given */
  const { service, timers } = setup();
  await service.open('s1');

  /* When */
  service.transcriptsChanged('other');

  /* Then */
  assert.equal(timers.timeouts.size, 0);
});

test('a write to the session\'s transcript folder rebuilds the page', async () => {
  /* Given */
  const { service, timers } = setup();
  await service.open('s1');
  service.transcriptsChanged('other');

  /* When */
  service.transcriptsChanged('f1');

  /* Then */
  assert.equal(timers.timeouts.size, 1);
});

const polledPr = () => setup({ pullRequests: [prLink(6)], prs: [prStatus(6)] });

test('gh is asked on open, and polled every minute', async () => {
  /* Given */
  const { service, timers, calls } = polledPr();

  /* When */
  await service.open('s1');

  /* Then */
  assert.equal(calls.pullRequests, 1);
  assert.deepEqual([...timers.intervals.values()].map((interval) => interval.ms), [GITHUB_REFRESH_MS]);
});

test('a commit does not ask GitHub', async () => {
  /* Given */
  const { service, timers, calls, live } = polledPr();
  await service.open('s1');

  /* When */
  live()[0].onChange();
  timers.fireTimeouts();
  await settle();

  /* Then */
  assert.equal(calls.pullRequests, 1, 'a commit does not ask GitHub');
});

test('gh is asked again every minute, and only then', async () => {
  /* Given */
  const { service, timers, calls, live } = polledPr();
  await service.open('s1');
  live()[0].onChange();
  timers.fireTimeouts();
  await settle();

  /* When */
  timers.fireIntervals();
  await settle();

  /* Then */
  assert.equal(calls.pullRequests, 2);
  assert.equal(calls.available, 2);
});

test('close stops the watchers and the polling', async () => {
  /* Given */
  const { service, timers, watchers } = setup();
  await service.open('s1');
  watchers[0].onChange();

  /* When */
  service.close('s1');

  /* Then */
  assert.ok(watchers.every((w) => w.disposed));
  assert.equal(timers.timeouts.size, 0);
  assert.equal(timers.intervals.size, 0);
  assert.equal(service.openSessionId, null);
});

test('a watcher event after close does nothing', async () => {
  /* Given */
  const { service, timers, watchers, snapshots } = setup();
  await service.open('s1');
  const [watcher] = watchers;
  watcher.onChange();
  service.close('s1');

  /* When */
  watcher.onChange();

  /* Then */
  assert.equal(timers.timeouts.size, 0);
  assert.equal(snapshots.length, 1);
});

test('a diff asked for after close is empty', async () => {
  /* Given */
  const { service } = setup();
  await service.open('s1');
  service.close('s1');

  /* When */
  const diff = await service.diff('s1', 'anything');

  /* Then */
  assert.deepEqual(diff, { files: [], source: null });
});

test('opening a second session closes the first', async () => {
  /* Given */
  const { service, timers, watchers } = setup();
  await service.open('s1');
  const first = [...watchers];

  /* When */
  await service.open('s2');

  /* Then */
  assert.ok(first.every((w) => w.disposed));
  assert.equal(service.openSessionId, 's2');
  assert.equal(timers.intervals.size, 1, 'one poll, for the open page');
});

test('a stale close for the first session is ignored', async () => {
  /* Given */
  const { service, watchers } = setup();
  await service.open('s1');
  const first = [...watchers];
  await service.open('s2');

  /* When */
  service.close('s1');

  /* Then */
  assert.equal(service.openSessionId, 's2');
  assert.ok(watchers.filter((w) => !first.includes(w)).every((w) => !w.disposed));
});

// ── Actions ──

const PR6 = `pr:https://github.com/${REPO}/pull/6`;
const rebaseQueued = (): SessionActivities => ({
  byItem: new Map([[PR6, { id: 'a1', action: 'rebase', phase: 'queued', origin: 'manual', queuedAt: 'x' }]]),
  queued: 1,
  shipping: false,
});

test('with nothing under way an item has no activity and nothing is queued', async () => {
  /* Given */
  const { service, last } = polledPr();

  /* When */
  await service.open('s1');

  /* Then */
  const before = last().items[0];
  assert.equal(before.kind === 'pr' && before.activity, null);
  assert.equal(last().queued, 0);
});

test('an action\'s phase is laid over its item, and pushed without asking git or gh again', async () => {
  /* Given */
  const { service, world, snapshots, calls, last } = polledPr();
  await service.open('s1');
  const asked = calls.pullRequests;

  /* When */
  world.activities = rebaseQueued();
  service.activitiesChanged('s1');

  /* Then */
  assert.equal(snapshots.length, 2);
  const item = last().items[0];
  assert.equal(item.kind === 'pr' && item.activity?.phase, 'queued');
  assert.equal(last().queued, 1);
  assert.equal(calls.pullRequests, asked);
});

test('the same activities again push nothing', async () => {
  /* Given */
  const { service, world, snapshots } = polledPr();
  await service.open('s1');
  world.activities = rebaseQueued();
  service.activitiesChanged('s1');

  /* When */
  service.activitiesChanged('s1');

  /* Then */
  assert.equal(snapshots.length, 2, 'nothing changed, nothing pushed');
});

test('the open page answers for its items', async () => {
  /* Given */
  const { service } = polledPr();
  await service.open('s1');

  /* When */
  const item = service.item('s1', PR6);

  /* Then */
  assert.equal(item?.kind, 'pr');
});

test('the open page answers nothing for another session\'s item or an unknown one', async () => {
  /* Given */
  const { service } = polledPr();
  await service.open('s1');

  /* When */
  const otherSession = service.item('s2', PR6);
  const unknown = service.item('s1', 'nope');

  /* Then */
  assert.equal(otherSession, null);
  assert.equal(unknown, null);
});

test('the open page answers for its context', async () => {
  /* Given */
  const { service } = polledPr();
  await service.open('s1');

  /* When */
  const context = service.context('s1');

  /* Then */
  assert.deepEqual(context, { repository: REPO, mainCheckout: ROOT, gh: 'ok' });
});

test('the open page has no context for another session', async () => {
  /* Given */
  const { service } = polledPr();
  await service.open('s1');

  /* When */
  const context = service.context('s2');

  /* Then */
  assert.equal(context, null);
});

const shipping = (): SessionActivities => ({
  byItem: new Map([[PR6, { id: 'a1', action: 'ship', phase: 'sent', origin: 'manual', queuedAt: 'x' }]]),
  queued: 0,
  shipping: true,
});

async function shippingPage() {
  const harness = polledPr();
  await harness.service.open('s1');
  const cadence = () => [...harness.timers.intervals.values()].map((interval) => interval.ms).sort((a, b) => a - b);
  return { ...harness, cadence };
}

test('without a Ship it under way gh is asked every minute', async () => {
  /* When */
  const { cadence } = await shippingPage();

  /* Then */
  assert.deepEqual(cadence(), [GITHUB_REFRESH_MS]);
});

test('while a Ship it is under way gh is asked every 20 s instead of every minute', async () => {
  /* Given */
  const { service, world, cadence } = await shippingPage();

  /* When */
  world.activities = shipping();
  service.activitiesChanged('s1');

  /* Then */
  assert.deepEqual(cadence(), [SHIP_REFRESH_MS, GITHUB_REFRESH_MS]);
});

test('while a Ship it is under way each tick asks gh once', async () => {
  /* Given */
  const { service, world, timers, calls } = await shippingPage();
  world.activities = shipping();
  service.activitiesChanged('s1');
  const asked = calls.pullRequests;

  /* When */
  // Each 20 s tick asks; the minute's tick stands aside while it runs.
  timers.fireIntervals();
  await settle();

  /* Then */
  assert.equal(calls.pullRequests, asked + 1);
});

test('once the Ship it is over gh is asked every minute again', async () => {
  /* Given */
  const { service, world, timers, cadence } = await shippingPage();
  world.activities = shipping();
  service.activitiesChanged('s1');
  timers.fireIntervals();
  await settle();

  /* When */
  world.activities = { byItem: new Map(), queued: 0, shipping: false };
  service.activitiesChanged('s1');

  /* Then */
  assert.deepEqual(cadence(), [GITHUB_REFRESH_MS]);
});

test('closing during a Ship it stops both polls', async () => {
  /* Given */
  const { service, world, timers } = await shippingPage();
  world.activities = shipping();
  service.activitiesChanged('s1');
  timers.fireIntervals();
  await settle();
  world.activities = { byItem: new Map(), queued: 0, shipping: false };
  service.activitiesChanged('s1');
  world.activities = { ...world.activities, shipping: true };
  service.activitiesChanged('s1');

  /* When */
  service.close('s1');

  /* Then */
  assert.equal(timers.intervals.size, 0, 'closing stops both polls');
});

test('the footprint counts every worktree and branch the session worked in, not only the items\' ones', async () => {
  // The main checkout on main (no item: it is the default branch) and a PR's
  // branch in an agent worktree that has since merged (an item, but not one in progress).
  /* Given */
  const { service } = setup({
    locations: [
      { cwd: ROOT, branch: 'main', fromSubagent: false },
      { cwd: AGENT, branch: 'feat/agent', fromSubagent: true },
    ],
  });

  /* When */
  const snapshot = await service.open('s1');

  /* Then */
  assert.deepEqual(snapshot?.items, []);
  assert.deepEqual(snapshot?.footprint, { worktrees: 2, branches: 2 });
});

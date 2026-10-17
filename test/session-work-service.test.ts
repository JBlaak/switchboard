import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_REFRESH_MS, SessionWorkService, WATCH_DEBOUNCE_MS, type SessionWorkTarget,
} from '../src/application/services/session-work-service';
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

  const github: GitHubCli = {
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
  const { service } = setup();
  assert.equal(await service.canOpen('s1'), true);
  assert.equal(await service.canOpen('remote'), false);
  assert.equal(await service.canOpen('loose'), false);
  assert.equal(await service.canOpen('nobody'), false);
});

test('open answers null, and starts nothing, where canOpen is false', async () => {
  const { service, snapshots, timers } = setup();
  assert.equal(await service.open('remote'), null);
  assert.equal(await service.open('loose'), null);
  assert.deepEqual(snapshots, []);
  assert.equal(timers.intervals.size, 0);
});

// ── Snapshots ──

test('nothing changed yet: an empty snapshot, pushed once, and not again when a rebuild finds the same', async () => {
  const { service, snapshots, timers, live } = setup();
  const first = await service.open('s1');
  assert.deepEqual(first?.items, []);
  assert.equal(first?.gh, 'ok');
  assert.equal(first?.sessionId, 's1');
  assert.equal(first?.repository, REPO, 'from the origin remote');
  assert.equal(snapshots.length, 1);
  assert.equal(typeof first?.updatedAt, 'string');

  live()[0].onChange();
  timers.fireTimeouts();
  await settle();
  timers.fireIntervals();
  await settle();
  assert.equal(snapshots.length, 1, 'nothing new to push');
});

test('a cwd in a subdirectory resolves to its worktree root, and lines in one root merge into one place', async () => {
  const { service, world, calls, live } = setup({
    locations: [
      { cwd: ROOT + '/src', branch: 'feat/1-thing', fromSubagent: true },
      { cwd: ROOT + '/src/deep', branch: 'feat/1-thing', fromSubagent: false },
      { cwd: ROOT + '/src', branch: 'feat/1-thing', fromSubagent: true },
    ],
    branches: new Set(['main', 'feat/1-thing']),
    ahead: new Map([['feat/1-thing', 2]]),
    gh: 'missing',
  });
  world.status.set(ROOT, [{ path: 'x.ts', status: 'modified' }]);
  const snapshot = await service.open('s1');
  const branch = snapshot!.items.find((item) => item.kind === 'branch');
  assert.ok(branch && branch.kind === 'branch');
  assert.deepEqual(branch.location, { worktree: ROOT, branch: 'feat/1-thing', fromSubagent: false });
  assert.equal(branch.ahead, 2);
  assert.equal(branch.id, 'branch:' + ROOT + '\0feat/1-thing');
  assert.deepEqual(live().map((watcher) => watcher.worktree), [ROOT], 'one watcher per worktree');

  const before = calls.worktreeRoot;
  world.locations = [...world.locations];
  await service.open('s1');
  // Each cwd is resolved once; only the root itself is checked again.
  assert.equal(calls.worktreeRoot - before, 1);
});

test('a subagent worktree is its own place, marked as the subagent\'s, and watched', async () => {
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
  const snapshot = await service.open('s1');
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
  const { service } = setup({
    pullRequests: [prLink(7), prLink(8)],
    prs: [prStatus(7, { state: 'merged', title: 'Old' }), prStatus(8, { title: 'New' })],
  });
  const snapshot = await service.open('s1');
  assert.deepEqual(snapshot!.items.map((item) => item.kind === 'pr' && [item.pr.number, item.pr.state]), [
    [8, 'open'],
    [7, 'merged'],
  ]);
  assert.ok(snapshot!.items.every((item) => !item.error));
});

test('a PR whose branch was deleted takes its diff from gh, cached by its head commit', async () => {
  const { service, world, calls } = setup({
    pullRequests: [prLink(9)],
    prs: [prStatus(9, { headRef: 'feat/gone' })],
  });
  const snapshot = await service.open('s1');
  const pr = snapshot!.items[0];
  assert.ok(pr.kind === 'pr');
  assert.deepEqual(pr.diff, { kind: 'pull-request', repository: REPO, number: 9 });

  const files = await service.diff('s1', pr.id);
  assert.deepEqual(files.map((file) => [file.path, file.additions, file.deletions]), [['a.txt', 1, 1]]);
  await service.diff('s1', pr.id);
  assert.equal(calls.pullRequestDiff, 1, 'the second ask is cached');

  world.prs = [prStatus(9, { headRef: 'feat/gone', headSha: 'pushed-again' })];
  await service.open('s1');
  await service.diff('s1', pr.id);
  assert.equal(calls.pullRequestDiff, 2, 'a new head commit is a new diff');
});

test('a PR whose branch is checked out diffs locally, cached by both commits, with generated files collapsed', async () => {
  const { service, world, calls } = setup({
    locations: [{ cwd: ROOT, branch: 'feat/3-x', fromSubagent: false }],
    branches: new Set(['main', 'feat/3-x']),
    pullRequests: [prLink(3)],
    prs: [prStatus(3, { headRef: 'feat/3-x' })],
    generated: ['a.txt'],
  });
  const snapshot = await service.open('s1');
  const pr = snapshot!.items[0];
  assert.ok(pr.kind === 'pr');
  assert.deepEqual(pr.diff, { kind: 'local', worktree: ROOT, base: 'origin/main', head: 'feat/3-x' });

  const files = await service.diff('s1', pr.id);
  assert.equal(files[0].collapsedReason, 'generated');
  await service.diff('s1', pr.id);
  assert.equal(calls.branchDiff, 1);
  assert.equal(calls.pullRequestDiff, undefined);

  world.shas.set('feat/3-x', 'new-commit');
  await service.diff('s1', pr.id);
  assert.equal(calls.branchDiff, 2, 'a new commit on the branch is a new diff');
});

test('uncommitted changes are diffed fresh every time', async () => {
  const { service, world, calls } = setup();
  world.status.set(ROOT, [{ path: 'a.txt', status: 'modified' }]);
  const snapshot = await service.open('s1');
  const dirty = snapshot!.items[0];
  assert.equal(dirty.kind, 'dirty');
  await service.diff('s1', dirty.id);
  await service.diff('s1', dirty.id);
  assert.equal(calls.workingDiff, 2);
});

test('a worktree that is gone drops out, and its watcher with it', async () => {
  const { service, world, live, timers } = setup({
    locations: [
      { cwd: ROOT, branch: 'main', fromSubagent: false },
      { cwd: AGENT, branch: 'feat/agent', fromSubagent: true },
      { cwd: '/code/app/.claude/worktrees/removed-long-ago', branch: 'feat/old', fromSubagent: true },
    ],
    branches: new Set(['main', 'feat/agent']),
    ahead: new Map([['feat/agent', 1]]),
  });
  const first = await service.open('s1');
  assert.deepEqual(first!.items.map((item) => item.kind), ['branch']);
  assert.deepEqual(live().map((watcher) => watcher.worktree).sort(), [AGENT, ROOT].sort());

  // The agent's worktree is removed (its branch kept); the next rebuild drops it.
  world.roots.delete(AGENT);
  live().find((watcher) => watcher.worktree === AGENT)!.onChange();
  timers.fireTimeouts();
  await settle();
  assert.deepEqual(live().map((watcher) => watcher.worktree), [ROOT]);
});

test('without gh the page has git-only data, says why, and never asks GitHub for PRs', async () => {
  for (const gh of ['missing', 'unauthenticated'] as const) {
    const { service, calls, snapshots } = setup({
      gh,
      pullRequests: [prLink(4)],
      prs: [prStatus(4, { state: 'merged' })],
    });
    const snapshot = await service.open('s1');
    assert.equal(snapshot!.gh, gh);
    const pr = snapshot!.items[0];
    assert.ok(pr.kind === 'pr');
    assert.equal(pr.pr.state, undefined, 'unknown, not merged');
    assert.equal(pr.error, undefined);
    assert.equal(calls.pullRequests, undefined);
    assert.equal(calls.issues, undefined);

    // Its branch is not here and gh cannot fetch it: no diff, and the item says why.
    assert.deepEqual(await service.diff('s1', pr.id), []);
    const marked = snapshots[snapshots.length - 1].items[0];
    assert.match(marked.error ?? '', gh === 'missing' ? /not installed/ : /not signed in/);
  }
});

test('a failed gh request marks its PRs, not the page', async () => {
  const { service, world } = setup({
    pullRequests: [prLink(5)],
    prs: null,
  });
  world.status.set(ROOT, [{ path: 'a.txt', status: 'modified' }]);
  const snapshot = await service.open('s1');
  assert.equal(snapshot!.gh, 'ok');
  const pr = snapshot!.items.find((item) => item.kind === 'pr')!;
  assert.match(pr.error ?? '', /GitHub did not answer/);
  const dirty = snapshot!.items.find((item) => item.kind === 'dirty')!;
  assert.equal(dirty.error, undefined);
});

test('issues gh confirms are listed with their title; a mention that is a PR drops out', async () => {
  const { service } = setup({
    mentions: [{ repository: '', number: 12 }, { repository: '', number: 88 }],
    issues: [{ repository: REPO, number: 12, title: 'Bug', state: 'open', url: 'https://github.com/o/app/issues/12' }],
  });
  const snapshot = await service.open('s1');
  assert.deepEqual(snapshot!.items.map((item) => item.kind === 'issue' && item.issue), [
    { repository: '', number: 12, title: 'Bug', state: 'open', url: 'https://github.com/o/app/issues/12' },
  ]);
});

// ── Watching ──

test('a burst of watcher events rebuilds once, after the debounce', async () => {
  const { service, world, timers, live, snapshots } = setup();
  await service.open('s1');
  const [watcher] = live();
  watcher.onChange();
  watcher.onChange();
  watcher.onChange();
  assert.equal(timers.timeouts.size, 1);
  assert.equal([...timers.timeouts.values()][0].ms, WATCH_DEBOUNCE_MS);

  world.status.set(ROOT, [{ path: 'a.txt', status: 'modified' }]);
  timers.fireTimeouts();
  await settle();
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].items[0].kind, 'dirty');
});

test('a write to the session\'s transcript folder rebuilds the page; another folder\'s does not', async () => {
  const { service, timers } = setup();
  await service.open('s1');
  service.transcriptsChanged('other');
  assert.equal(timers.timeouts.size, 0);
  service.transcriptsChanged('f1');
  assert.equal(timers.timeouts.size, 1);
});

test('gh is asked again every minute, and only then', async () => {
  const { service, timers, calls, live } = setup({ pullRequests: [prLink(6)], prs: [prStatus(6)] });
  await service.open('s1');
  assert.equal(calls.pullRequests, 1);
  assert.deepEqual([...timers.intervals.values()].map((interval) => interval.ms), [GITHUB_REFRESH_MS]);

  live()[0].onChange();
  timers.fireTimeouts();
  await settle();
  assert.equal(calls.pullRequests, 1, 'a commit does not ask GitHub');

  timers.fireIntervals();
  await settle();
  assert.equal(calls.pullRequests, 2);
  assert.equal(calls.available, 2);
});

test('close stops the watchers and the polling, and a late event does nothing', async () => {
  const { service, timers, watchers, snapshots } = setup();
  await service.open('s1');
  const [watcher] = watchers;
  watcher.onChange();
  service.close('s1');
  assert.ok(watchers.every((w) => w.disposed));
  assert.equal(timers.timeouts.size, 0);
  assert.equal(timers.intervals.size, 0);
  assert.equal(service.openSessionId, null);

  watcher.onChange();
  assert.equal(timers.timeouts.size, 0);
  assert.equal(snapshots.length, 1);
  assert.deepEqual(await service.diff('s1', 'anything'), []);
});

test('opening a second session closes the first; a stale close for the first is ignored', async () => {
  const { service, timers, watchers } = setup();
  await service.open('s1');
  const first = [...watchers];
  await service.open('s2');
  assert.ok(first.every((w) => w.disposed));
  assert.equal(service.openSessionId, 's2');
  assert.equal(timers.intervals.size, 1, 'one poll, for the open page');

  service.close('s1');
  assert.equal(service.openSessionId, 's2');
  assert.ok(watchers.filter((w) => !first.includes(w)).every((w) => !w.disposed));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOSING_REFS_TTL_MS, IssueSessionService, type IssueSessionCandidate,
} from '../src/application/services/issue-session-service';
import type { WorktreeSummary } from '../src/domain/project/overview';
import type { IssueKey, Plan, PlanIssue, PlanPullRequest } from '../src/domain/plan/model';
import type { PullRequestCloses } from '../src/application/ports/github-cli';
import type { TranscriptLocation } from '../src/application/ports/transcript-store';
import { FakeStartGit, silentLog } from './support/fakes';

const REPO = 'JBlaak/switchboard';
const ROOT = '/dev/switchboard';
const ORIGIN = 'git@github.com:JBlaak/switchboard.git';

function key(number: number): IssueKey {
  return { repository: REPO, number };
}

function pr(number: number, headRef: string): PlanPullRequest {
  return { number, state: 'open', draft: false, additions: 1, deletions: 1, headRef, baseRef: 'main' };
}

function issue(number: number, title: string, fields: Partial<PlanIssue> = {}): PlanIssue {
  return {
    repository: REPO, number, title, state: 'open', closedAs: null, updatedAt: '2026-10-17T00:00:00Z',
    blockedBy: [], pullRequests: [], summary: '', acceptance: [], ...fields,
  };
}

function plan(issues: PlanIssue[]): Plan {
  return { repository: REPO, number: 112, title: 'Image compare', parent: null, issues, outside: [] };
}

function checkout(path: string, branch: string, fields: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return { path, branch, main: false, locked: false, changedFiles: 0, ahead: 0, merged: false, lastCommitAt: null, ...fields };
}

interface Harness {
  service: IssueSessionService;
  git: FakeStartGit;
  ghCalls: string[];
  now: { value: number };
}

function harness({
  sessions = [], origin = ORIGIN, statuses = [], locations = {},
}: {
  sessions?: IssueSessionCandidate[];
  origin?: string | null;
  statuses?: PullRequestCloses[];
  locations?: Record<string, TranscriptLocation[]>;
} = {}): Harness {
  const git = new FakeStartGit(ROOT);
  const ghCalls: string[] = [];
  const now = { value: 1_000_000 };
  const service = new IssueSessionService({
    sessions: () => sessions,
    transcripts: {
      locations: (_folder, sessionId) => locations[sessionId] ?? [],
    },
    git: git.port,
    remotes: { originUrl: async () => origin },
    github: {
      available: async () => 'ok',
      closingIssues: async (repo, numbers) => {
        ghCalls.push(repo + ' ' + numbers.join(','));
        return statuses.filter((status) => numbers.includes(status.number));
      },
    },
    clock: { now: () => now.value },
    log: silentLog,
  });
  return { service, git, ghCalls, now };
}

function session(sessionId: string, fields: Partial<IssueSessionCandidate> = {}): IssueSessionCandidate {
  return { sessionId, projectPath: ROOT, folder: 'folder-' + sessionId, activeAt: 0, pullRequests: [], ...fields };
}

function at(branch: string): TranscriptLocation {
  return { cwd: ROOT + '/.claude/worktrees/' + branch, branch, fromSubagent: false };
}

// ── Preparing the worktree (A2, A3) ──

test('a Ready issue gets a worktree on its own branch off the fetched default branch', async () => {
  /* Given */
  const { service, git } = harness();
  const ready = plan([issue(114, 'Zoom and pan')]);

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: key(114), plan: ready });

  /* Then */
  assert.deepEqual(result, {
    ok: true,
    worktreePath: ROOT + '/.claude/worktrees/114-zoom-and-pan',
    branch: '114-zoom-and-pan',
    prompt: 'Work on #114, part of #112. Read the epic and the issue first. Open a PR titled with a short summary of what you implemented, with "Closes #114" in its description.',
  });
  assert.deepEqual(git.writes, [
    'fetch main',
    `worktree add -b 114-zoom-and-pan ${ROOT}/.claude/worktrees/114-zoom-and-pan origin/main`,
  ]);
});

test('a Locked issue stacks on its blocker\'s PR head and says so in the prompt', async () => {
  /* Given */
  const { service, git } = harness();
  git.remoteBranches.add('113-overlay');
  const locked = plan([
    issue(113, 'Overlay', { pullRequests: [pr(119, '113-overlay')] }),
    issue(114, 'Stage', { blockedBy: [key(113)] }),
  ]);

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: key(114), plan: locked });

  /* Then */
  assert.equal(result.ok && result.stackedOn, 119);
  assert.match(result.ok ? result.prompt : '', /Branch off PR #119's branch and open your PR against it\./);
  assert.deepEqual(git.writes, [
    'fetch 113-overlay',
    `worktree add -b 114-stage ${ROOT}/.claude/worktrees/114-stage origin/113-overlay`,
  ]);
});

test('a Locked issue whose blocker has no PR starts from the default branch with a warning', async () => {
  /* Given */
  const { service, git } = harness();
  const locked = plan([issue(113, 'Overlay'), issue(114, 'Stage', { blockedBy: [key(113)] })]);

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: key(114), plan: locked });

  /* Then */
  assert.equal(result.ok && result.stackedOn, undefined);
  assert.equal(result.ok && result.warning, 'No open PR to stack on: #113 has none yet; started from main.');
  assert.match(git.writes[1], / origin\/main$/);
});

test('a blocker PR whose branch cannot be fetched falls back to the default branch with a warning', async () => {
  /* Given */
  const { service, git } = harness();
  git.unfetchable.set('113-overlay', "couldn't find remote ref refs/heads/113-overlay");
  const locked = plan([
    issue(113, 'Overlay', { pullRequests: [pr(119, '113-overlay')] }),
    issue(114, 'Stage', { blockedBy: [key(113)] }),
  ]);

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: key(114), plan: locked });

  /* Then */
  assert.equal(result.ok && result.stackedOn, undefined);
  assert.match(result.ok ? result.warning ?? '' : '', /Could not fetch #119's branch 113-overlay .*started from main instead/);
  assert.doesNotMatch(result.ok ? result.prompt : '', /Branch off/);
});

test('a branch that already exists is refused, saying where it is and what is on it, and nothing is written', async () => {
  /* Given */
  const worktree = ROOT + '/.claude/worktrees/114-stage';
  const { service, git } = harness({
    sessions: [
      session('older', { projectPath: worktree, activeAt: 1, archived: true }),
      session('newer', { projectPath: worktree, activeAt: 2, archived: true }),
      session('elsewhere', { activeAt: 3 }),
    ],
  });
  git.branches.add('114-stage');
  git.checkouts = [checkout(ROOT, 'main', { main: true }), checkout(worktree, '114-stage', { changedFiles: 3, ahead: 2 })];

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]) });

  /* Then */
  assert.deepEqual(result, {
    ok: false,
    reason: 'Branch 114-stage already exists',
    existing: { branch: '114-stage', worktreePath: worktree, main: false, changedFiles: 3, ahead: 2, sessionId: 'newer' },
  });
  assert.deepEqual(git.writes, []);
});

test('an existing branch without a worktree names the session whose transcripts were written on it', async () => {
  /* Given */
  const { service, git } = harness({
    sessions: [session('on-it', { activeAt: 5, archived: true }), session('other', { activeAt: 9 })],
    locations: { 'on-it': [at('114-stage')], other: [at('main')] },
  });
  git.branches.add('114-stage');

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]) });

  /* Then */
  assert.deepEqual(!result.ok && result.existing, {
    branch: '114-stage', worktreePath: null, main: false, changedFiles: 0, ahead: 0, sessionId: 'on-it',
  });
});

test('continuing on an existing branch starts in its worktree, with the prompt to pick up the work', async () => {
  /* Given */
  const worktree = '/elsewhere/114-stage';
  const { service, git } = harness();
  git.branches.add('114-stage');
  git.checkouts = [checkout(worktree, '114-stage')];

  /* When */
  const result = await service.prepareIssueWorktree({
    projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]), existing: 'reuse',
  });

  /* Then */
  assert.equal(result.ok && result.worktreePath, worktree);
  assert.equal(result.ok && result.branch, '114-stage');
  assert.match(result.ok ? result.prompt : '', /^Continue work on #114, part of #112/);
  assert.deepEqual(git.writes, []);
});

test('continuing on an existing branch without a worktree adds one for it', async () => {
  /* Given */
  const { service, git } = harness();
  git.branches.add('114-stage');

  /* When */
  const result = await service.prepareIssueWorktree({
    projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]), existing: 'reuse',
  });

  /* Then */
  assert.equal(result.ok && result.worktreePath, ROOT + '/.claude/worktrees/114-stage');
  assert.deepEqual(git.writes, ['worktree prune', `worktree add ${ROOT}/.claude/worktrees/114-stage 114-stage`]);
});

test('replacing an existing branch deletes its worktree and branch, then starts afresh from the default branch', async () => {
  /* Given */
  const worktree = ROOT + '/.claude/worktrees/114-stage';
  const { service, git } = harness();
  git.branches.add('114-stage');
  git.checkouts = [checkout(worktree, '114-stage', { changedFiles: 1 })];

  /* When */
  const result = await service.prepareIssueWorktree({
    projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]), existing: 'replace',
  });

  /* Then */
  assert.equal(result.ok && result.worktreePath, worktree);
  assert.match(result.ok ? result.prompt : '', /^Work on #114/);
  assert.deepEqual(git.writes, [
    `worktree remove --force ${worktree}`,
    'worktree prune',
    'branch -D 114-stage',
    'fetch main',
    `worktree add -b 114-stage ${worktree} origin/main`,
  ]);
});

test('replacing an existing branch stops, with git\'s reason, when its worktree cannot be deleted', async () => {
  /* Given */
  const worktree = ROOT + '/.claude/worktrees/114-stage';
  const { service, git } = harness();
  git.branches.add('114-stage');
  git.checkouts = [checkout(worktree, '114-stage')];
  git.failing.set('remove', 'Permission denied');

  /* When */
  const result = await service.prepareIssueWorktree({
    projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]), existing: 'replace',
  });

  /* Then */
  assert.deepEqual(result, { ok: false, reason: 'Could not delete the worktree: Permission denied' });
  assert.deepEqual(git.writes, [`worktree remove --force ${worktree}`]);
});

test('a branch checked out in the main checkout is never deleted', async () => {
  /* Given */
  const { service, git } = harness();
  git.branches.add('114-stage');
  git.checkouts = [checkout(ROOT, '114-stage', { main: true })];

  /* When */
  const result = await service.prepareIssueWorktree({
    projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]), existing: 'replace',
  });

  /* Then */
  assert.equal(!result.ok && result.reason, 'Branch 114-stage is checked out in the main checkout, which is never deleted');
  assert.deepEqual(git.writes, []);
});

test('an archived session owns no issue', async () => {
  /* Given */
  const { service } = harness({
    sessions: [session('archived', { activeAt: 5, archived: true })],
    locations: { archived: [at('114-stage')] },
  });

  /* When */
  const owners = await service.issueSessions(REPO);

  /* Then */
  assert.deepEqual(owners, {});
});

test('a project whose origin is not on GitHub is refused', async () => {
  /* Given */
  const { service, git } = harness({ origin: 'git@gitlab.com:acme/api.git' });

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: key(114), plan: plan([issue(114, 'Stage')]) });

  /* Then */
  assert.deepEqual(result, { ok: false, reason: 'Not a GitHub repository: its origin is not on github.com' });
  assert.deepEqual(git.writes, []);
});

test('a project outside a git repository is refused', async () => {
  /* Given */
  const { service, git } = harness();
  git.checkout = null;

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: '/tmp/notes', issue: key(114), plan: plan([issue(114, 'Stage')]) });

  /* Then */
  assert.deepEqual(result, { ok: false, reason: 'Not a git repository: /tmp/notes' });
});

test('an issue from another repository is refused', async () => {
  /* Given */
  const { service } = harness();
  const other = { repository: 'JBlaak/James', number: 22 };

  /* When */
  const result = await service.prepareIssueWorktree({ projectPath: ROOT, issue: other, plan: plan([issue(114, 'Stage')]) });

  /* Then */
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /#22 is in JBlaak\/James, not in this project's JBlaak\/switchboard/);
});

// ── Ownership (S1) ──

test('a session whose transcripts were on an issue\'s branch owns it', async () => {
  /* Given */
  const { service } = harness({
    sessions: [session('a')],
    locations: { a: [at('main'), at('114-zoom-pan-stage')] },
  });

  /* When */
  const owners = await service.issueSessions(REPO);

  /* Then */
  assert.deepEqual(owners, { [REPO + '#114']: 'a' });
});

test('a session just started, with no transcript yet, owns the issue its directory\'s branch is named after', async () => {
  /* Given */
  const worktree = ROOT + '/.claude/worktrees/114-stage';
  const { service, git } = harness({ sessions: [session('new', { projectPath: worktree, folder: null })] });
  git.current.set(worktree, '114-stage');

  /* When */
  const owners = await service.issueSessions(REPO);

  /* Then */
  assert.deepEqual(owners, { [REPO + '#114']: 'new' });
});

test('a session whose PR closes an issue owns it, and the closing refs are asked once', async () => {
  /* Given */
  const closing: PullRequestCloses = { number: 130, closes: [{ repository: REPO, number: 114 }] };
  const { service, ghCalls } = harness({
    sessions: [session('a', { pullRequests: [{ number: 130, url: 'https://github.com/' + REPO + '/pull/130', repository: REPO }] })],
    locations: { a: [at('feature/stage')] },
    statuses: [closing],
  });

  /* When */
  const first = await service.issueSessions(REPO);
  const second = await service.issueSessions(REPO);

  /* Then */
  assert.deepEqual(first, { [REPO + '#114']: 'a' });
  assert.deepEqual(second, first);
  assert.deepEqual(ghCalls, [REPO + ' 130']);
});

test('the closing refs are asked again once they are a few minutes old', async () => {
  /* Given */
  const { service, ghCalls, now } = harness({
    sessions: [session('a', { pullRequests: [{ number: 130, url: '', repository: REPO }] })],
    statuses: [{ number: 130, closes: [] }],
  });
  await service.issueSessions(REPO);

  /* When */
  now.value += CLOSING_REFS_TTL_MS;
  await service.issueSessions(REPO);

  /* Then */
  assert.equal(ghCalls.length, 2);
});

test('sessions of another repository own nothing in this one', async () => {
  /* Given */
  const { service } = harness({
    origin: 'https://github.com/JBlaak/James.git',
    sessions: [session('a')],
    locations: { a: [at('114-zoom')] },
  });

  /* When */
  const owners = await service.issueSessions(REPO);

  /* Then */
  assert.deepEqual(owners, {});
});

test('of two sessions owning an issue, the more recently active one wins', async () => {
  /* Given */
  const { service } = harness({
    sessions: [session('older', { activeAt: 1 }), session('newer', { activeAt: 2 })],
    locations: { older: [at('114-zoom')], newer: [at('fix/114-zoom-again')] },
  });

  /* When */
  const owners = await service.issueSessions(REPO);

  /* Then */
  assert.equal(owners[REPO + '#114'], 'newer');
});

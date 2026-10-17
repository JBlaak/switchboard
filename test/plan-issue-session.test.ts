import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueOwners, startBase, type IssueOwnerCandidate } from '../src/domain/plan/issue-session';
import type { IssueKey, Plan, PlanIssue, PlanPullRequest } from '../src/domain/plan/model';

const REPO = 'JBlaak/switchboard';

function key(number: number, repository = REPO): IssueKey {
  return { repository, number };
}

function pr(number: number, state: PlanPullRequest['state'], headRef = 'branch-' + number): PlanPullRequest {
  return { number, state, draft: false, additions: 1, deletions: 1, headRef, baseRef: 'main' };
}

function issue(number: number, fields: Partial<PlanIssue> = {}): PlanIssue {
  return {
    repository: REPO, number, title: 'Issue ' + number, state: 'open', closedAs: null,
    updatedAt: '2026-10-17T00:00:00Z', blockedBy: [], pullRequests: [], summary: '', acceptance: [],
    ...fields,
  };
}

function plan(issues: PlanIssue[], outside: PlanIssue[] = []): Plan {
  return { repository: REPO, number: 112, title: 'Epic', parent: null, issues, outside };
}

function candidate(sessionId: string, fields: Partial<IssueOwnerCandidate> = {}): IssueOwnerCandidate {
  return { sessionId, activeAt: 0, branches: [], closes: [], ...fields };
}

// ── Where the worktree starts (A3) ──

test('a Ready issue starts from the default branch', () => {
  /* Given */
  const ready = plan([
    issue(113, { state: 'closed', closedAs: 'completed' }),
    issue(114, { blockedBy: [key(113)] }),
  ]);

  /* When */
  const base = startBase(ready, key(114));

  /* Then */
  assert.deepEqual(base, { kind: 'default', openBlockers: [] });
});

test('a Locked issue stacks on its open blocker\'s open PR', () => {
  /* Given */
  const locked = plan([
    issue(118, { pullRequests: [pr(130, 'closed'), pr(131, 'open', '118-zoom')] }),
    issue(114, { blockedBy: [key(118)] }),
  ]);

  /* When */
  const base = startBase(locked, key(114));

  /* Then */
  assert.equal(base.kind, 'stacked');
  assert.deepEqual(base.kind === 'stacked' && [base.blocker, base.pullRequest.number, base.pullRequest.headRef],
    [key(118), 131, '118-zoom']);
});

test('of several open blockers, the one with an open PR is stacked on', () => {
  /* Given */
  const locked = plan([
    issue(117),
    issue(118, { pullRequests: [pr(131, 'open')] }),
    issue(114, { blockedBy: [key(117), key(118)] }),
  ]);

  /* When */
  const base = startBase(locked, key(114));

  /* Then */
  assert.equal(base.kind === 'stacked' && base.pullRequest.number, 131);
});

test('a blocker outside the plan with an open PR is stacked on too', () => {
  /* Given */
  const ghost = issue(9, { repository: 'JBlaak/other', pullRequests: [pr(10, 'open')] });
  const locked = plan([issue(114, { blockedBy: [key(9, 'JBlaak/other')] })], [ghost]);

  /* When */
  const base = startBase(locked, key(114));

  /* Then */
  assert.deepEqual(base.kind === 'stacked' && base.blocker, key(9, 'JBlaak/other'));
});

test('open blockers without an open PR start from the default branch and are named', () => {
  /* Given */
  const locked = plan([
    issue(117, { pullRequests: [pr(130, 'merged')] }),
    issue(118, { state: 'closed', closedAs: 'not_planned' }),
    issue(114, { blockedBy: [key(117), key(118)] }),
  ]);

  /* When */
  const base = startBase(locked, key(114));

  /* Then */
  assert.deepEqual(base, { kind: 'default', openBlockers: [key(117)] });
});

// ── Ownership (S1) ──

test('a session on a branch named after an issue owns it', () => {
  /* Given */
  const sessions = [candidate('a', { branches: ['main', '114-zoom-pan-stage'] })];

  /* When */
  const owners = issueOwners(sessions, REPO);

  /* Then */
  assert.deepEqual(owners, { [REPO + '#114']: 'a' });
});

test('a session whose PR closes an issue owns it, whatever its branch is called', () => {
  /* Given */
  const sessions = [candidate('a', { branches: ['feature/stage'], closes: [key(114)] })];

  /* When */
  const owners = issueOwners(sessions, REPO);

  /* Then */
  assert.deepEqual(owners, { [REPO + '#114']: 'a' });
});

test('a session with no branch or PR for an issue owns nothing, whatever it talked about', () => {
  /* Given: the conversation's mentions are not an input at all */
  const sessions = [candidate('a', { branches: ['main', 'worktree-agent-ac45974d'] })];

  /* When */
  const owners = issueOwners(sessions, REPO);

  /* Then */
  assert.deepEqual(owners, {});
});

test('when two sessions own an issue the most recently active one wins', () => {
  /* Given */
  const sessions = [
    candidate('older', { activeAt: 1_000, branches: ['114-zoom'] }),
    candidate('newer', { activeAt: 2_000, closes: [key(114)] }),
    candidate('oldest', { activeAt: 500, branches: ['fix/114-again'] }),
  ];

  /* When */
  const owners = issueOwners(sessions, REPO);

  /* Then */
  assert.equal(owners[REPO + '#114'], 'newer');
});

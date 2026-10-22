import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GhCli, type GhResult, type GhRunner } from '../src/infrastructure/github/gh-cli';

/** A runner that answers from a script and records what it was asked. */
function scripted(answer: (args: readonly string[]) => Partial<GhResult>): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (args: readonly string[]) => {
    calls.push([...args]);
    return { missing: false, code: 0, stdout: '', stderr: '', ...answer(args) };
  }) as GhRunner & { calls: string[][] };
  run.calls = calls;
  return run;
}

const answering = (body: unknown) => scripted(() => ({ stdout: JSON.stringify(body) }));
const missing = (): Partial<GhResult> => ({ missing: true, code: null });
const signedOut = (): Partial<GhResult> => ({
  code: 4,
  stderr: 'To get started with GitHub CLI, please run:  gh auth login\n',
});
const unreachable = (): Partial<GhResult> => ({
  code: 1,
  stderr: 'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
});

/** The GraphQL query text of a recorded `gh api graphql` call. */
const queryOf = (args: readonly string[]) => args[args.indexOf('-f') + 1].replace(/^query=/, '');

/** No check failed, so each state counts zero. */
const zeroCounts = (states: string[]) => states.map((state) => ({ state, count: 0 }));
const CHECK_RUN_STATES = ['ACTION_REQUIRED', 'CANCELLED', 'COMPLETED', 'FAILURE', 'IN_PROGRESS', 'NEUTRAL', 'PENDING',
  'QUEUED', 'SKIPPED', 'STALE', 'STARTUP_FAILURE', 'SUCCESS', 'TIMED_OUT', 'WAITING'];
const STATUS_STATES = ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'];

/** A rollup as GitHub answers it, with `counts` set over zeros for every other state. */
function rollup(state: string, runs: Record<string, number> = {}, statuses: Record<string, number> = {}) {
  return {
    state,
    contexts: {
      checkRunCountsByState: zeroCounts(CHECK_RUN_STATES).map((entry) => ({ ...entry, count: runs[entry.state] ?? 0 })),
      statusContextCountsByState: zeroCounts(STATUS_STATES).map((entry) => ({ ...entry, count: statuses[entry.state] ?? 0 })),
    },
  };
}

const SWITCHBOARD = { nameWithOwner: 'JBlaak/switchboard' };

/** Recorded from JBlaak/switchboard on 2026-10-22, trimmed to three issues. */
const recordedIssues = {
  data: {
    repository: {
      issues: {
        nodes: [
          {
            number: 169, title: "Read a repository's open issues, pull requests and worktrees", state: 'OPEN',
            updatedAt: '2026-10-22T09:58:52Z', repository: SWITCHBOARD,
            labels: { nodes: [{ name: 'ready-for-agent', color: '8fd8bf' }] },
            parent: { number: 167, repository: SWITCHBOARD },
            subIssuesSummary: { total: 0 },
          },
          {
            number: 167, title: 'Project page per repository, and a Projects modal in place of New Session', state: 'OPEN',
            updatedAt: '2026-10-22T09:59:03Z', repository: SWITCHBOARD,
            labels: { nodes: [{ name: 'ready-for-agent', color: '8fd8bf' }, { name: 'enhancement', color: 'a2eeef' }] },
            parent: null,
            subIssuesSummary: { total: 10 },
          },
          {
            number: 154, title: 'Quick Ask follow-ups', state: 'CLOSED',
            updatedAt: '2026-10-20T14:02:11Z', repository: SWITCHBOARD,
            labels: { nodes: [] },
            parent: { number: 142, repository: { nameWithOwner: 'JBlaak/planning' } },
            subIssuesSummary: { total: 0 },
          },
        ],
      },
    },
  },
};

/** Recorded from JBlaak/switchboard, with checks and reviews set to cover each state. */
const recordedPullRequests = {
  data: {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 166, title: 'Quick Ask: ⌘Enter starts a quick session without routing', state: 'MERGED', isDraft: false,
            headRefName: 'quick-ask-cmd-enter', updatedAt: '2026-10-22T08:20:16Z', reviewDecision: null, repository: SWITCHBOARD,
            statusCheckRollup: rollup('SUCCESS', { SKIPPED: 1, SUCCESS: 3 }),
            closingIssuesReferences: { nodes: [] },
          },
          {
            number: 180, title: 'Read a repository\'s open issues', state: 'OPEN', isDraft: false,
            headRefName: 'issue-169-overview-reads', updatedAt: '2026-10-22T11:00:00Z', reviewDecision: 'CHANGES_REQUESTED',
            repository: SWITCHBOARD,
            statusCheckRollup: rollup('FAILURE', { FAILURE: 1, TIMED_OUT: 1, SUCCESS: 2 }, { ERROR: 1 }),
            closingIssuesReferences: {
              nodes: [
                { number: 169, repository: SWITCHBOARD },
                { number: 12, repository: { nameWithOwner: 'JBlaak/planning' } },
              ],
            },
          },
          {
            number: 181, title: 'Group a project\'s issues under their plans', state: 'OPEN', isDraft: true,
            headRefName: 'issue-170-grouping', updatedAt: '2026-10-22T10:30:00Z', reviewDecision: 'REVIEW_REQUIRED',
            repository: SWITCHBOARD,
            statusCheckRollup: rollup('PENDING', { IN_PROGRESS: 1, SUCCESS: 1 }),
            closingIssuesReferences: { nodes: [{ number: 170, repository: SWITCHBOARD }] },
          },
          {
            number: 182, title: 'Docs only', state: 'OPEN', isDraft: false,
            headRefName: 'docs', updatedAt: '2026-10-22T09:00:00Z', reviewDecision: 'APPROVED', repository: SWITCHBOARD,
            statusCheckRollup: null,
            closingIssuesReferences: { nodes: [] },
          },
        ],
      },
    },
  },
};

// ── Issues ──

test('a repository\'s open issues are one GraphQL request, newest first, with labels, parent and sub-issue count', async () => {
  /* Given */
  const run = answering(recordedIssues);

  /* When */
  await new GhCli({ run }).issuesIn('JBlaak/switchboard', { closed: false });

  /* Then */
  assert.equal(run.calls.length, 1);
  const query = queryOf(run.calls[0]);
  assert.match(query, /issues\(states: \[OPEN\], first: 100, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/);
  assert.match(query, /labels\(first: 20\) \{ nodes \{ name color \} \}/);
  assert.match(query, /parent \{ number repository \{ nameWithOwner \} \}/);
  assert.match(query, /subIssuesSummary \{ total \}/);
  assert.deepEqual(run.calls[0].slice(-4), ['-f', 'owner=JBlaak', '-f', 'name=switchboard']);
});

test('closed issues are asked for only when wanted', async () => {
  /* Given */
  const run = answering(recordedIssues);

  /* When */
  await new GhCli({ run }).issuesIn('JBlaak/switchboard', { closed: true });

  /* Then */
  assert.match(queryOf(run.calls[0]), /issues\(states: \[OPEN, CLOSED\]/);
});

test('a recorded answer maps to issues with their labels, parent and sub-issue count, newest first', async () => {
  /* Given */
  const gh = new GhCli({ run: answering(recordedIssues) });

  /* When */
  const issues = await gh.issuesIn('JBlaak/switchboard', { closed: true });

  /* Then */
  assert.deepEqual(issues, [
    {
      repository: 'JBlaak/switchboard', number: 167,
      title: 'Project page per repository, and a Projects modal in place of New Session', state: 'open',
      labels: [{ name: 'ready-for-agent', color: '8fd8bf' }, { name: 'enhancement', color: 'a2eeef' }],
      updatedAt: '2026-10-22T09:59:03Z', parent: null, subIssues: 10,
    },
    {
      repository: 'JBlaak/switchboard', number: 169,
      title: "Read a repository's open issues, pull requests and worktrees", state: 'open',
      labels: [{ name: 'ready-for-agent', color: '8fd8bf' }],
      updatedAt: '2026-10-22T09:58:52Z', parent: { repository: 'JBlaak/switchboard', number: 167 }, subIssues: 0,
    },
    {
      repository: 'JBlaak/switchboard', number: 154, title: 'Quick Ask follow-ups', state: 'closed',
      labels: [], updatedAt: '2026-10-20T14:02:11Z', parent: { repository: 'JBlaak/planning', number: 142 }, subIssues: 0,
    },
  ]);
});

test('an issue missing fields falls back rather than failing', async () => {
  /* Given */
  const gh = new GhCli({ run: answering({ data: { repository: { issues: { nodes: [{ number: 5 }, null, { title: 'no number' }] } } } }) });

  /* When */
  const issues = await gh.issuesIn('acme/web', { closed: false });

  /* Then */
  assert.deepEqual(issues, [
    { repository: 'acme/web', number: 5, title: '', state: 'closed', labels: [], updatedAt: '', parent: null, subIssues: 0 },
  ]);
});

// ── Pull requests ──

test('a repository\'s open pull requests are one GraphQL request with checks counted by state', async () => {
  /* Given */
  const run = answering(recordedPullRequests);

  /* When */
  await new GhCli({ run }).pullRequestsIn('JBlaak/switchboard', { merged: false });

  /* Then */
  assert.equal(run.calls.length, 1);
  const query = queryOf(run.calls[0]);
  assert.match(query, /pullRequests\(states: \[OPEN\], first: 50, orderBy: \{ field: UPDATED_AT, direction: DESC \}\)/);
  assert.match(query, /reviewDecision/);
  assert.match(query, /checkRunCountsByState \{ state count \}/);
  assert.match(query, /statusContextCountsByState \{ state count \}/);
  assert.match(query, /closingIssuesReferences\(first: 20\)/);
  assert.deepEqual(run.calls[0].slice(-4), ['-f', 'owner=JBlaak', '-f', 'name=switchboard']);
});

test('merged pull requests are asked for only when wanted', async () => {
  /* Given */
  const run = answering(recordedPullRequests);

  /* When */
  await new GhCli({ run }).pullRequestsIn('JBlaak/switchboard', { merged: true });

  /* Then */
  assert.match(queryOf(run.calls[0]), /pullRequests\(states: \[OPEN, MERGED\]/);
});

test('a recorded answer maps to pull requests with their checks, review and closing issues, newest first', async () => {
  /* Given */
  const gh = new GhCli({ run: answering(recordedPullRequests) });

  /* When */
  const prs = await gh.pullRequestsIn('JBlaak/switchboard', { merged: true });

  /* Then */
  assert.deepEqual(prs, [
    {
      repository: 'JBlaak/switchboard', number: 180, title: 'Read a repository\'s open issues', state: 'open', draft: false,
      headRef: 'issue-169-overview-reads', updatedAt: '2026-10-22T11:00:00Z',
      checks: { state: 'failing', failing: 3 }, review: 'changes_requested',
      closes: [{ repository: 'JBlaak/switchboard', number: 169 }, { repository: 'JBlaak/planning', number: 12 }],
    },
    {
      repository: 'JBlaak/switchboard', number: 181, title: 'Group a project\'s issues under their plans', state: 'open', draft: true,
      headRef: 'issue-170-grouping', updatedAt: '2026-10-22T10:30:00Z',
      checks: { state: 'running', failing: 0 }, review: 'review_required',
      closes: [{ repository: 'JBlaak/switchboard', number: 170 }],
    },
    {
      repository: 'JBlaak/switchboard', number: 182, title: 'Docs only', state: 'open', draft: false,
      headRef: 'docs', updatedAt: '2026-10-22T09:00:00Z',
      checks: { state: 'none', failing: 0 }, review: 'approved', closes: [],
    },
    {
      repository: 'JBlaak/switchboard', number: 166, title: 'Quick Ask: ⌘Enter starts a quick session without routing',
      state: 'merged', draft: false, headRef: 'quick-ask-cmd-enter', updatedAt: '2026-10-22T08:20:16Z',
      checks: { state: 'passing', failing: 0 }, review: null, closes: [],
    },
  ]);
});

test('one failed check makes the rollup failing while others still run', async () => {
  /* Given */
  const body = structuredClone(recordedPullRequests) as any;
  body.data.repository.pullRequests.nodes[2].statusCheckRollup = rollup('PENDING', { IN_PROGRESS: 2, CANCELLED: 1 });
  const gh = new GhCli({ run: answering(body) });

  /* When */
  const prs = await gh.pullRequestsIn('JBlaak/switchboard', { merged: false });

  /* Then */
  assert.deepEqual(prs?.find((pr) => pr.number === 181)?.checks, { state: 'failing', failing: 1 });
});

// ── When gh cannot answer ──

for (const [why, result] of [['missing', missing], ['signed out', signedOut], ['unreachable', unreachable]] as const) {
  test(`both reads answer null when gh is ${why}, without throwing`, async () => {
    /* Given */
    const gh = new GhCli({ run: scripted(result) });

    /* When */
    const issues = await gh.issuesIn('JBlaak/switchboard', { closed: false });
    const prs = await gh.pullRequestsIn('JBlaak/switchboard', { merged: false });

    /* Then */
    assert.equal(issues, null);
    assert.equal(prs, null);
  });
}

test('both reads answer null when GitHub knows no such repository', async () => {
  /* Given */
  const run = scripted(() => ({
    code: 1,
    stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }),
  }));
  const gh = new GhCli({ run });

  /* When */
  const issues = await gh.issuesIn('acme/gone', { closed: false });
  const prs = await gh.pullRequestsIn('acme/gone', { merged: false });

  /* Then */
  assert.equal(issues, null);
  assert.equal(prs, null);
});

test('a repository name that is not owner/repo is never sent to gh', async () => {
  /* Given */
  const run = answering(recordedIssues);
  const gh = new GhCli({ run });

  /* When */
  const issues = await gh.issuesIn('not a repo', { closed: false });
  const prs = await gh.pullRequestsIn('acme', { merged: false });

  /* Then */
  assert.equal(issues, null);
  assert.equal(prs, null);
  assert.equal(run.calls.length, 0);
});

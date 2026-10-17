import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueFromBranch, issueMentionsInText, issueMentionsInTranscript, standaloneIssues,
} from '../src/domain/session-work/issues';
import { mergeWorkLocations, workLocations, worktreeRootOf } from '../src/domain/session-work/locations';

const REPO = 'owner/repo';

test('#123, owner/repo#123 and closing keywords are mentions, in order, once each', () => {
  /* Given */
  const text = 'Look at #12 and other/thing#7. This closes #12, fixes #3 and Resolves owner/repo#4.';

  /* When */
  const mentions = issueMentionsInText(text, REPO);

  /* Then */
  assert.deepEqual(mentions, [
    { repository: REPO, number: 12 },
    { repository: 'other/thing', number: 7 },
    { repository: REPO, number: 3 },
    { repository: REPO, number: 4 },
  ]);
});

test('a GitHub issue URL is a mention; a pull request URL is not', () => {
  /* Given */
  const text = 'See https://github.com/acme/web/issues/42 and https://github.com/acme/web/pull/43';

  /* When */
  const mentions = issueMentionsInText(text, REPO);

  /* Then */
  assert.deepEqual(mentions, [{ repository: 'acme/web', number: 42 }]);
});

test('hashes that are part of something else are not mentions', () => {
  /* When */
  const mentions = issueMentionsInText('&#123; a#1 path/#2 x.y#3 #abc #0', REPO);

  /* Then */
  assert.deepEqual(mentions, []);
});

test('a bare mention takes the session\'s repository, or none when it is unknown', () => {
  /* When */
  const mentions = issueMentionsInText('(#9)', '');

  /* Then */
  assert.deepEqual(mentions, [{ repository: '', number: 9 }]);
});

test('the issue a branch is named after', () => {
  /* Given */
  const cases: Array<[string, number]> = [['fix/123-foo', 123], ['45-bar', 45], ['issue/67', 67]];

  for (const [branch, number] of cases) {
    /* When */
    const issue = issueFromBranch(branch, REPO);

    /* Then */
    assert.deepEqual(issue, { repository: REPO, number });
  }
});

test('a branch not named after an issue has none', () => {
  /* Given */
  const branches = ['feat/session-work-domain', 'fix/v2-thing', 'main'];

  for (const branch of branches) {
    /* When */
    const issue = issueFromBranch(branch, REPO);

    /* Then */
    assert.equal(issue, null, branch);
  }
});

test('transcript mentions come from what was said, not tool output or thinking', () => {
  /* Given */
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Please do #71' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'maybe #500' },
      { type: 'text', text: 'Working on #71, related to #70.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'gh issue view 72' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', content: '#1 #2 #3 open issues' },
    ] } }),
    JSON.stringify({ type: 'pr-link', prNumber: 90, prUrl: 'https://github.com/owner/repo/pull/90' }),
    'not json',
  ];

  /* When */
  const mentions = issueMentionsInTranscript(lines, REPO);

  /* Then */
  assert.deepEqual(mentions, [
    { repository: REPO, number: 71 },
    { repository: REPO, number: 70 },
  ]);
});

test('issues a PR closes, and the session\'s own PRs, are not listed on their own', () => {
  /* Given */
  const mentions = [
    { repository: REPO, number: 1 },
    { repository: '', number: 2 },
    { repository: REPO, number: 3 },
    { repository: 'other/repo', number: 4 },
    { repository: REPO, number: 4 },
  ];
  const claimed = [{ repository: REPO, number: 2 }, { repository: '', number: 3 }, { repository: 'other/repo', number: 1 }];

  /* When */
  const standalone = standaloneIssues(mentions, claimed);

  /* Then */
  assert.deepEqual(standalone, [
    { repository: REPO, number: 1 },
    { repository: 'other/repo', number: 4 },
    { repository: REPO, number: 4 },
  ]);
});

test('a cwd resolves to the deepest worktree root containing it', () => {
  /* Given */
  const roots = ['/repo', '/repo/.claude/worktrees/agent-1/'];
  const cases: Array<[string, string]> = [
    ['/repo/src/domain', '/repo'],
    ['/repo/.claude/worktrees/agent-1/src', '/repo/.claude/worktrees/agent-1'],
    ['/repo', '/repo'],
    ['/repository', '/repository'],
    ['/elsewhere', '/elsewhere'],
  ];

  for (const [cwd, expected] of cases) {
    /* When */
    const root = worktreeRootOf(cwd, roots);

    /* Then */
    assert.equal(root, expected, cwd);
  }
});

test('work locations come from every transcript, once per worktree and branch', () => {
  /* Given */
  const line = (cwd: string, gitBranch?: string) => JSON.stringify({ type: 'user', cwd, gitBranch });
  const roots = ['/repo', '/repo/.claude/worktrees/a'];
  const transcripts = [
    { fromSubagent: false, lines: [line('/repo', 'main'), line('/repo/src', 'main'), line('/repo', 'HEAD'), line('/repo')] },
    { fromSubagent: true, lines: [line('/repo/.claude/worktrees/a/src', 'feat/a'), line('/repo', 'main')] },
    { fromSubagent: true, lines: [line('/repo/.claude/worktrees/a', 'feat/a'), line('/repo/.claude/worktrees/a', 'feat/b')] },
    { fromSubagent: false, lines: [line('/repo/.claude/worktrees/a', 'feat/b')] },
  ];

  /* When */
  const locations = workLocations(transcripts, roots);

  /* Then */
  assert.deepEqual(locations, [
    { worktree: '/repo', branch: 'main', fromSubagent: false },
    { worktree: '/repo/.claude/worktrees/a', branch: 'feat/a', fromSubagent: true },
    { worktree: '/repo/.claude/worktrees/a', branch: 'feat/b', fromSubagent: false },
  ]);
});

test('mergeWorkLocations makes one place of each worktree and branch, a subagent\'s only while nobody else went there', () => {
  /* Given */
  const locations = [
    { worktree: '/repo', branch: 'feat/a', fromSubagent: true },
    { worktree: '/repo/.claude/worktrees/b', branch: 'feat/b', fromSubagent: true },
    { worktree: '/repo', branch: 'feat/a', fromSubagent: false },
    { worktree: '/repo/.claude/worktrees/b', branch: 'feat/b', fromSubagent: true },
  ];

  /* When */
  const merged = mergeWorkLocations(locations);

  /* Then */
  assert.deepEqual(merged, [
    { worktree: '/repo', branch: 'feat/a', fromSubagent: false },
    { worktree: '/repo/.claude/worktrees/b', branch: 'feat/b', fromSubagent: true },
  ]);
});

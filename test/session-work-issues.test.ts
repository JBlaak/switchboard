import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  issueFromBranch, issueMentionsInText, issueMentionsInTranscript, standaloneIssues,
} from '../src/domain/session-work/issues';
import { mergeWorkLocations, workLocations, worktreeRootOf } from '../src/domain/session-work/locations';

const REPO = 'owner/repo';

test('#123, owner/repo#123 and closing keywords are mentions, in order, once each', () => {
  assert.deepEqual(
    issueMentionsInText('Look at #12 and other/thing#7. This closes #12, fixes #3 and Resolves owner/repo#4.', REPO),
    [
      { repository: REPO, number: 12 },
      { repository: 'other/thing', number: 7 },
      { repository: REPO, number: 3 },
      { repository: REPO, number: 4 },
    ],
  );
});

test('a GitHub issue URL is a mention; a pull request URL is not', () => {
  assert.deepEqual(issueMentionsInText(
    'See https://github.com/acme/web/issues/42 and https://github.com/acme/web/pull/43', REPO),
  [{ repository: 'acme/web', number: 42 }]);
});

test('hashes that are part of something else are not mentions', () => {
  assert.deepEqual(issueMentionsInText('&#123; a#1 path/#2 x.y#3 #abc #0', REPO), []);
});

test('a bare mention takes the session\'s repository, or none when it is unknown', () => {
  assert.deepEqual(issueMentionsInText('(#9)', ''), [{ repository: '', number: 9 }]);
});

test('the issue a branch is named after', () => {
  assert.deepEqual(issueFromBranch('fix/123-foo', REPO), { repository: REPO, number: 123 });
  assert.deepEqual(issueFromBranch('45-bar', REPO), { repository: REPO, number: 45 });
  assert.deepEqual(issueFromBranch('issue/67', REPO), { repository: REPO, number: 67 });
  assert.equal(issueFromBranch('feat/session-work-domain', REPO), null);
  assert.equal(issueFromBranch('fix/v2-thing', REPO), null);
  assert.equal(issueFromBranch('main', REPO), null);
});

test('transcript mentions come from what was said, not tool output or thinking', () => {
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
  assert.deepEqual(issueMentionsInTranscript(lines, REPO), [
    { repository: REPO, number: 71 },
    { repository: REPO, number: 70 },
  ]);
});

test('issues a PR closes, and the session\'s own PRs, are not listed on their own', () => {
  const mentions = [
    { repository: REPO, number: 1 },
    { repository: '', number: 2 },
    { repository: REPO, number: 3 },
    { repository: 'other/repo', number: 4 },
    { repository: REPO, number: 4 },
  ];
  const claimed = [{ repository: REPO, number: 2 }, { repository: '', number: 3 }, { repository: 'other/repo', number: 1 }];
  assert.deepEqual(standaloneIssues(mentions, claimed), [
    { repository: REPO, number: 1 },
    { repository: 'other/repo', number: 4 },
    { repository: REPO, number: 4 },
  ]);
});

test('a cwd resolves to the deepest worktree root containing it', () => {
  const roots = ['/repo', '/repo/.claude/worktrees/agent-1/'];
  assert.equal(worktreeRootOf('/repo/src/domain', roots), '/repo');
  assert.equal(worktreeRootOf('/repo/.claude/worktrees/agent-1/src', roots), '/repo/.claude/worktrees/agent-1');
  assert.equal(worktreeRootOf('/repo', roots), '/repo');
  assert.equal(worktreeRootOf('/repository', roots), '/repository');
  assert.equal(worktreeRootOf('/elsewhere', roots), '/elsewhere');
});

test('work locations come from every transcript, once per worktree and branch', () => {
  const line = (cwd: string, gitBranch?: string) => JSON.stringify({ type: 'user', cwd, gitBranch });
  const roots = ['/repo', '/repo/.claude/worktrees/a'];
  const locations = workLocations([
    { fromSubagent: false, lines: [line('/repo', 'main'), line('/repo/src', 'main'), line('/repo', 'HEAD'), line('/repo')] },
    { fromSubagent: true, lines: [line('/repo/.claude/worktrees/a/src', 'feat/a'), line('/repo', 'main')] },
    { fromSubagent: true, lines: [line('/repo/.claude/worktrees/a', 'feat/a'), line('/repo/.claude/worktrees/a', 'feat/b')] },
    { fromSubagent: false, lines: [line('/repo/.claude/worktrees/a', 'feat/b')] },
  ], roots);
  assert.deepEqual(locations, [
    { worktree: '/repo', branch: 'main', fromSubagent: false },
    { worktree: '/repo/.claude/worktrees/a', branch: 'feat/a', fromSubagent: true },
    { worktree: '/repo/.claude/worktrees/a', branch: 'feat/b', fromSubagent: false },
  ]);
});

test('mergeWorkLocations makes one place of each worktree and branch, a subagent\'s only while nobody else went there', () => {
  const merged = mergeWorkLocations([
    { worktree: '/repo', branch: 'feat/a', fromSubagent: true },
    { worktree: '/repo/.claude/worktrees/b', branch: 'feat/b', fromSubagent: true },
    { worktree: '/repo', branch: 'feat/a', fromSubagent: false },
    { worktree: '/repo/.claude/worktrees/b', branch: 'feat/b', fromSubagent: true },
  ]);
  assert.deepEqual(merged, [
    { worktree: '/repo', branch: 'feat/a', fromSubagent: false },
    { worktree: '/repo/.claude/worktrees/b', branch: 'feat/b', fromSubagent: true },
  ]);
});

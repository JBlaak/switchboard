import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPrompt, threadLine } from '../src/domain/session-work/prompts';
import type { ReviewThread } from '../src/domain/session-work/model';

const URL = 'https://github.com/owner/repo/pull/12';

test('Ship it', () => {
  /* Given */
  const request = {
    action: 'ship' as const, number: 12, url: URL, base: 'main', method: 'squash' as const,
    worktree: '/repo/.claude/worktrees/a', mainCheckout: '/repo',
  };

  /* When */
  const prompt = renderPrompt(request);

  /* Then */
  assert.equal(prompt,
    'Ship PR #12 (https://github.com/owner/repo/pull/12). If it is behind origin/main, rebase it onto origin/main and force-push with lease. ' +
    'Wait for CI with gh pr checks 12 --watch. If a check fails, fix it and push, at most twice; if it still fails, stop and tell me. ' +
    'When everything is green, merge it with gh pr merge 12 --squash --delete-branch, remove the worktree /repo/.claude/worktrees/a ' +
    'if nothing else is in it, and pull main in /repo.');
});

test('Ship it from the main checkout has no worktree to remove', () => {
  /* Given */
  const request = {
    action: 'ship' as const, number: 12, url: URL, base: 'main', method: 'merge' as const, worktree: '/repo', mainCheckout: '/repo',
  };

  /* When */
  const prompt = renderPrompt(request);

  /* Then */
  assert.equal(prompt,
    'Ship PR #12 (https://github.com/owner/repo/pull/12). If it is behind origin/main, rebase it onto origin/main and force-push with lease. ' +
    'Wait for CI with gh pr checks 12 --watch. If a check fails, fix it and push, at most twice; if it still fails, stop and tell me. ' +
    'When everything is green, merge it with gh pr merge 12 --merge --delete-branch, pull main in /repo.');
});

test('Rebase', () => {
  /* When */
  const prompt = renderPrompt({ action: 'rebase', number: 12, headRef: 'feat/a', base: 'main' });

  /* Then */
  assert.equal(prompt,
    'Rebase PR #12 (feat/a) onto origin/main and force-push with lease. ' +
    'Resolve conflicts if there are any; if a conflict needs a decision from me, stop and ask.');
});

const fixCi = {
  action: 'fix-ci' as const, number: 12, url: URL, checkName: 'test', sha: 'abc1234',
  logTail: 'line 1\nline 2', worktree: '/wt',
};

test('Fix CI, manual', () => {
  /* When */
  const prompt = renderPrompt(fixCi);

  /* Then */
  assert.equal(prompt,
    'CI is failing on PR #12 (https://github.com/owner/repo/pull/12): test failed on abc1234. Log tail:\nline 1\nline 2\nFix it in /wt and push.');
});

test('Fix CI, automatic', () => {
  /* When */
  const prompt = renderPrompt({ ...fixCi, automaticAttempt: 2 });

  /* Then */
  assert.equal(prompt,
    'CI is failing on PR #12 (https://github.com/owner/repo/pull/12): test failed on abc1234. Log tail:\nline 1\nline 2\nFix it in /wt and push. ' +
    'This is automatic attempt 2 of 2.');
});

const thread = (id: string, path: string, line: number | null, author: string, body: string, resolved = false): ReviewThread => ({
  id, path, line, side: 'RIGHT', resolved,
  comments: [
    { author, isBot: false, body, createdAt: '2026-01-01T00:00:00Z' },
    { author: 'someone', isBot: false, body: 'a reply', createdAt: '2026-01-02T00:00:00Z' },
  ],
});

test('a thread line folds its first comment onto one line', () => {
  /* Given */
  const t = thread('PRRT_1', 'src/a.ts', 14, 'alice', 'Rename this.\n\nIt is confusing.');

  /* When */
  const line = threadLine(t);

  /* Then */
  assert.equal(line, 'src/a.ts:14 — alice: Rename this. It is confusing. (PRRT_1)');
});

test('a thread line without a line number names only the file', () => {
  /* Given */
  const t = thread('PRRT_2', 'README.md', null, 'bot', 'Typo');

  /* When */
  const line = threadLine(t);

  /* Then */
  assert.equal(line, 'README.md — bot: Typo (PRRT_2)');
});

test('Fix comments lists the open threads', () => {
  /* Given */
  const request = {
    action: 'fix-comments' as const, number: 12, url: URL, worktree: '/wt',
    threads: [
      thread('PRRT_1', 'src/a.ts', 14, 'alice', 'Rename this'),
      thread('PRRT_9', 'src/z.ts', 1, 'carol', 'Already done', true),
      thread('PRRT_2', 'src/b.ts', 3, 'bob', 'Missing test'),
    ],
  };

  /* When */
  const prompt = renderPrompt(request);

  /* Then */
  assert.equal(prompt,
    'Address the open review threads on PR #12 (https://github.com/owner/repo/pull/12):\n' +
    'src/a.ts:14 — alice: Rename this (PRRT_1)\n' +
    'src/b.ts:3 — bob: Missing test (PRRT_2)\n' +
    'For each one, fix it in /wt, push, then reply on the thread with what you changed and the commit, and resolve it. ' +
    'If you disagree or need my input, reply explaining why and leave it open.');
});

test('Open PR', () => {
  /* When */
  const prompt = renderPrompt({ action: 'open-pr', branch: 'feat/a', worktree: '/wt', base: 'main' });

  /* Then */
  assert.equal(prompt,
    "Push feat/a from /wt and open a pull request for it against main, following this repo's PR conventions.");
});

test('Create a pull request', () => {
  /* When */
  const prompt = renderPrompt({ action: 'create-pr', branch: 'main', worktree: '/wt' });

  /* Then */
  assert.equal(prompt,
    'Commit the uncommitted changes in /wt, on a new branch if main is the default branch, ' +
    "then push it and open a pull request for it, following this repo's commit and PR conventions.");
});

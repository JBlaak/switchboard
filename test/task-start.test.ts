import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueBranchName } from '../src/domain/plan/start';
import { issueFromBranch } from '../src/domain/session-work/issues';
import {
  taskBranchName, taskContinuePrompt, taskRouteText, taskSessionPrompt, type TaskStartInput,
} from '../src/domain/tasks/start';

const task: TaskStartInput = { id: 'task-42', title: 'Call Peter about the invoice', brief: 'He asked twice.' };

// ── The branch ──

test('a task branch is the issue branch rule without the number', () => {
  /* Given */
  const titles = ['Zoom and pan', 'Bel Peter over de offerte voor maandag', 'Café menu: prijzen!', 'a/b c.d'];

  /* When */
  const pairs = titles.map((title) => [taskBranchName(title), issueBranchName({ repository: 'o/r', number: 7, title })]);

  /* Then */
  for (const [taskBranch, issueBranch] of pairs) assert.equal('7-' + taskBranch, issueBranch);
});

test('a task branch keeps the first five words of the title, lower case and without accents', () => {
  /* Given */
  const title = 'Éérst de Offerte voor Peter afmaken en versturen';

  /* When */
  const branch = taskBranchName(title);

  /* Then */
  assert.equal(branch, 'eerst-de-offerte-voor-peter');
});

test('a title starting with a number gets task- in front, so its branch is never read as an issue\'s', () => {
  /* Given */
  const title = '2026 budget review';

  /* When */
  const branch = taskBranchName(title);

  /* Then */
  assert.equal(branch, 'task-2026-budget-review');
  assert.equal(issueFromBranch(branch, 'o/r'), null);
});

test('a title without letters or digits still names a branch', () => {
  /* Given */
  const title = '🚀 !!';

  /* When */
  const branch = taskBranchName(title);

  /* Then */
  assert.equal(branch, 'task');
});

// ── The prompts ──

test('a new session on a task starts with BlaakTasks\' handoff, saying it is already in progress', () => {
  /* Given */
  const input = task;

  /* When */
  const prompt = taskSessionPrompt(input);

  /* Then */
  assert.equal(prompt,
    'Work on my task “Call Peter about the invoice” (blaaktasks task-42): read it with get, log progress at every checkpoint and link the PR. ' +
    'It is already marked In progress; don\'t change its status.');
});

test('continuing a task reads the branch\'s earlier work first and still leaves the status alone', () => {
  /* Given */
  const input = task;

  /* When */
  const prompt = taskContinuePrompt(input);

  /* Then */
  assert.match(prompt, /^Continue work on my task “Call Peter about the invoice” \(blaaktasks task-42\): this branch already has earlier work on it\./);
  assert.match(prompt, /Read the task with get, then what the branch has so far/);
  assert.match(prompt, /It is already marked In progress; don't change its status\.$/);
});

// ── Routing ──

test('Ask Patch is asked with the title, then the brief', () => {
  /* Given */
  const input = task;

  /* When */
  const text = taskRouteText(input);

  /* Then */
  assert.equal(text, 'Call Peter about the invoice\n\nHe asked twice.');
});

test('a task without a brief is routed on its title alone', () => {
  /* Given */
  const input = { id: 'task-43', title: 'Renew the domain', brief: '  ' };

  /* When */
  const text = taskRouteText(input);

  /* Then */
  assert.equal(text, 'Renew the domain');
});

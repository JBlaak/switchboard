import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startIssueSessionWith, type StartIssueSessionSteps } from '../src/renderer/ui/session-work/plan/start-issue-session';
import type { IssueWorktreeResult } from '../src/domain/plan/issue-session';
import type { Plan } from '../src/domain/plan/model';
import type { SessionOptions } from '../src/domain/launch/session-options';

const REPO = 'JBlaak/switchboard';
const PLAN: Plan = { repository: REPO, number: 112, title: 'Epic', parent: null, issues: [], outside: [] };
const REQUEST = { projectPath: '/dev/switchboard', issue: { repository: REPO, number: 114 }, plan: PLAN };
const PREPARED: IssueWorktreeResult = {
  ok: true, worktreePath: '/dev/switchboard/.claude/worktrees/114-stage', branch: '114-stage', prompt: 'Work on #114',
};

function steps(prepared: IssueWorktreeResult, defaults: SessionOptions = {}) {
  const launches: { projectPath: string; options: SessionOptions }[] = [];
  const asked: string[] = [];
  const fake: StartIssueSessionSteps = {
    prepare: async () => prepared,
    defaultOptions: async (projectPath) => { asked.push(projectPath); return defaults; },
    launch: async (projectPath, options) => { launches.push({ projectPath, options }); return { ok: true, sessionId: 'new-session' }; },
  };
  return { fake, launches, asked };
}

test('a prepared worktree gets a session with the project\'s options and the prompt as its first prompt', async () => {
  /* Given */
  const { fake, launches, asked } = steps(PREPARED, { permissionMode: 'auto', worktree: true, chrome: true });

  /* When */
  const result = await startIssueSessionWith(fake, REQUEST);

  /* Then */
  assert.deepEqual(result, { ok: true, sessionId: 'new-session' });
  assert.deepEqual(asked, ['/dev/switchboard']);
  assert.deepEqual(launches, [{
    projectPath: '/dev/switchboard/.claude/worktrees/114-stage',
    options: { permissionMode: 'auto', chrome: true, initialPrompt: 'Work on #114' },
  }]);
});

test('a warning from main is passed on with the new session', async () => {
  /* Given */
  const { fake } = steps({ ...PREPARED, warning: 'No open PR to stack on' });

  /* When */
  const result = await startIssueSessionWith(fake, REQUEST);

  /* Then */
  assert.deepEqual(result, { ok: true, sessionId: 'new-session', warning: 'No open PR to stack on' });
});

test('a refusal from main starts nothing and answers its reason', async () => {
  /* Given */
  const { fake, launches } = steps({ ok: false, reason: 'Branch 114-stage already exists' });

  /* When */
  const result = await startIssueSessionWith(fake, REQUEST);

  /* Then */
  assert.deepEqual(result, { ok: false, reason: 'Branch 114-stage already exists' });
  assert.deepEqual(launches, []);
});

test('a session that fails to start answers why', async () => {
  /* Given */
  const { fake } = steps(PREPARED);
  fake.launch = async () => ({ ok: false, reason: 'Directory does not exist' });

  /* When */
  const result = await startIssueSessionWith(fake, REQUEST);

  /* Then */
  assert.deepEqual(result, { ok: false, reason: 'Directory does not exist' });
});

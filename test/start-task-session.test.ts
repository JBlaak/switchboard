import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NOT_LINKED, startTaskSessionWith, type StartTaskSessionSteps } from '../src/renderer/ui/tasks/start-task-session';
import type { SessionOptions } from '../src/domain/launch/session-options';
import type { TaskStartPreparation } from '../src/domain/tasks/surface';

const TASK = { id: '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9', title: 'Fix the login' };
const READY: TaskStartPreparation = {
  kind: 'ready', projectPath: '/dev/app', worktreePath: '/dev/app/.claude/worktrees/fix-the-login',
  branch: 'fix-the-login', prompt: 'Work on my task “Fix the login”',
};

function steps(prepared: TaskStartPreparation, { defaults = {} as SessionOptions, launches = true, links = true } = {}) {
  const order: string[] = [];
  const launched: { projectPath: string; options: SessionOptions; show: boolean }[] = [];
  const started: string[][] = [];
  const fake: StartTaskSessionSteps = {
    prepare: async () => { order.push('prepare'); return prepared; },
    defaultOptions: async (projectPath) => { order.push('defaults ' + projectPath); return defaults; },
    launch: async (projectPath, options, how) => {
      order.push('launch');
      launched.push({ projectPath, options, show: how.show });
      return launches ? { ok: true, sessionId: 'new-session' } : { ok: false, reason: 'no claude' };
    },
    started: async (taskId, sessionId, projectPath) => {
      order.push('started');
      started.push([taskId, sessionId, projectPath]);
      return links ? { ok: true } : { ok: false, error: 'BlaakTasks is off' };
    },
  };
  return { fake, order, launched, started };
}

test('a prepared task start launches with the project\'s options and the handoff, then links the session', async () => {
  /* Given */
  const { fake, order, launched, started } = steps(READY, { defaults: { permissionMode: 'auto', worktree: true, worktreeName: 'x', chrome: true } });

  /* When */
  const result = await startTaskSessionWith(fake, { task: TASK, show: false });

  /* Then */
  assert.deepEqual(result, { kind: 'started', sessionId: 'new-session', projectPath: '/dev/app' });
  assert.deepEqual(order, ['prepare', 'defaults /dev/app', 'launch', 'started']);
  assert.deepEqual(launched, [{
    projectPath: '/dev/app/.claude/worktrees/fix-the-login',
    options: { permissionMode: 'auto', chrome: true, initialPrompt: 'Work on my task “Fix the login”' },
    show: false,
  }]);
  assert.deepEqual(started, [[TASK.id, 'new-session', '/dev/app']]);
});

test('anything but ready comes back as it is, and nothing is launched or linked', async () => {
  /* Given */
  const answers: TaskStartPreparation[] = [
    { kind: 'unsure', candidates: ['/dev/app', '/dev/web'] },
    { kind: 'existing', projectPath: '/dev/app', reason: 'Branch fix-the-login already exists', existing: { branch: 'fix-the-login', worktreePath: null, main: false, changedFiles: 0, ahead: 1, sessionId: null } },
    { kind: 'noMatch', reason: 'Nothing fits' },
    { kind: 'off' },
  ];

  for (const answer of answers) {
    const { fake, order } = steps(answer);

    /* When */
    const result = await startTaskSessionWith(fake, { task: TASK });

    /* Then */
    assert.deepEqual(result, answer);
    assert.deepEqual(order, ['prepare']);
  }
});

test('a session that does not launch is not linked', async () => {
  /* Given */
  const { fake, order } = steps(READY, { launches: false });

  /* When */
  const result = await startTaskSessionWith(fake, { task: TASK });

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: 'no claude' });
  assert.deepEqual(order, ['prepare', 'defaults /dev/app', 'launch']);
});

test('a session that started but could not be linked says so, with main\'s own warning', async () => {
  /* Given */
  const { fake } = steps({ ...READY, warning: 'Could not fetch main.' } as TaskStartPreparation, { links: false });

  /* When */
  const result = await startTaskSessionWith(fake, { task: TASK });

  /* Then */
  assert.deepEqual(result, { kind: 'started', sessionId: 'new-session', projectPath: '/dev/app', warning: 'Could not fetch main. ' + NOT_LINKED });
});

test('a preparation that throws answers why', async () => {
  /* Given */
  const { fake } = steps(READY);
  fake.prepare = async () => { throw new Error('IPC gone'); };

  /* When */
  const result = await startTaskSessionWith(fake, { task: TASK });

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: 'IPC gone' });
});

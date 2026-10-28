import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectedLinkWins, repoTasks, sessionTask, taskIdFrom, taskOwner, taskRepo, taskSessions, type TaskLink,
} from '../src/domain/tasks/links';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

function link(sessionId: string | null, fields: Partial<TaskLink> = {}): TaskLink {
  return { taskId: TASK, projectPath: '/code/app', sessionId, source: 'start', linkedAt: 0, ...fields };
}

// ── Task ids ──

test('a task id is kept in Notion\'s dashed lowercase form, however it was written', () => {
  /* Given */
  const undashed = '1F2E3D4C5B6A49788695A4B3C2D1E0F9';

  /* When */
  const id = taskIdFrom(undashed);

  /* Then */
  assert.equal(id, TASK);
});

test('a value that cannot be a Notion page id is no task id', () => {
  /* Given */
  const values: unknown[] = ['', 'task-42', TASK + '0', 42, null, undefined];

  /* When */
  const ids = values.map(taskIdFrom);

  /* Then */
  assert.deepEqual(ids, values.map(() => null));
});

// ── A session's task ──

test('a session works on its newest link\'s task', () => {
  /* Given */
  const links = [link('s1', { linkedAt: 1 }), link('s1', { taskId: OTHER, linkedAt: 2 })];

  /* When */
  const task = sessionTask(links, 's1');

  /* Then */
  assert.equal(task?.taskId, OTHER);
});

test('a session without a link works on no task', () => {
  /* Given */
  const links = [link('s1')];

  /* When */
  const task = sessionTask(links, 's2');

  /* Then */
  assert.equal(task, null);
});

// ── A task's repo ──

test('a task\'s repo is its latest link\'s project', () => {
  /* Given */
  const links = [link('s1', { projectPath: '/code/old', linkedAt: 1 }), link('s2', { projectPath: '/code/new', linkedAt: 2 })];

  /* When */
  const repo = taskRepo(links, TASK);

  /* Then */
  assert.equal(repo, '/code/new');
});

test('a repo set by hand overrides the links before it', () => {
  /* Given */
  const links = [link('s1', { projectPath: '/code/app', linkedAt: 1 }), link(null, { projectPath: '/code/right', source: 'manual', linkedAt: 2 })];

  /* When */
  const repo = taskRepo(links, TASK);

  /* Then */
  assert.equal(repo, '/code/right');
});

test('a session that moved to another task no longer decides this one\'s repo', () => {
  /* Given */
  const links = [
    link('s1', { projectPath: '/code/app', linkedAt: 1 }),
    link('s2', { projectPath: '/code/elsewhere', linkedAt: 2 }),
    link('s2', { taskId: OTHER, projectPath: '/code/elsewhere', linkedAt: 3 }),
  ];

  /* When */
  const repo = taskRepo(links, TASK);

  /* Then */
  assert.equal(repo, '/code/app');
});

test('a task without links has no repo', () => {
  /* Given */
  const links = [link('s1', { taskId: OTHER })];

  /* When */
  const repo = taskRepo(links, TASK);

  /* Then */
  assert.equal(repo, null);
});

test('a project\'s tasks are the ones whose repo it is, the most recently linked first', () => {
  /* Given */
  const third = '2b3c4d5e-6f70-4a81-9b2c-3d4e5f6a7b8c';
  const links = [
    link('s1', { taskId: TASK, linkedAt: 1 }),
    link('s2', { taskId: OTHER, linkedAt: 2 }),
    link('s3', { taskId: third, linkedAt: 3 }),
    link(null, { taskId: third, projectPath: '/code/web', source: 'manual', linkedAt: 4 }),
  ];

  /* When */
  const tasks = repoTasks(links, '/code/app');

  /* Then */
  assert.deepEqual(tasks, [OTHER, TASK]);
});

// ── A task's sessions and owner ──

test('a task\'s sessions are listed once each, the most recently linked first, without a repo set by hand', () => {
  /* Given */
  const links = [link('s1', { linkedAt: 1 }), link('s2', { linkedAt: 2 }), link(null, { linkedAt: 3 }), link('s1', { linkedAt: 4 })];

  /* When */
  const sessions = taskSessions(links, TASK);

  /* Then */
  assert.deepEqual(sessions, ['s1', 's2']);
});

test('a task with several sessions is owned by the most recently active one', () => {
  /* Given */
  const links = [link('s1', { linkedAt: 1 }), link('s2', { linkedAt: 2 })];
  const activity: Record<string, number> = { s1: 500, s2: 100 };

  /* When */
  const owner = taskOwner(links, TASK, (sessionId) => activity[sessionId] ?? null);

  /* Then */
  assert.equal(owner, 's1');
});

test('a session that owns nothing, archived say, is passed over for owner', () => {
  /* Given */
  const links = [link('s1', { linkedAt: 1 }), link('s2', { linkedAt: 2 })];

  /* When */
  const owner = taskOwner(links, TASK, (sessionId) => (sessionId === 's1' ? null : 100));

  /* Then */
  assert.equal(owner, 's2');
});

test('a task whose sessions all own nothing has no owner', () => {
  /* Given */
  const links = [link('s1'), link(null)];

  /* When */
  const owner = taskOwner(links, TASK, () => null);

  /* Then */
  assert.equal(owner, null);
});

// ── A detected link ──

test('a detected task links a session that has none', () => {
  /* Given */
  const current = null;

  /* When */
  const wins = detectedLinkWins(current, { taskId: TASK, at: null });

  /* Then */
  assert.equal(wins, true);
});

test('a task named after the session\'s link was made replaces it', () => {
  /* Given */
  const current = link('s1', { taskId: OTHER, source: 'manual', linkedAt: 100 });

  /* When */
  const wins = detectedLinkWins(current, { taskId: TASK, at: 200 });

  /* Then */
  assert.equal(wins, true);
});

test('a task named before the session\'s link was made leaves the link alone', () => {
  /* Given */
  const current = link('s1', { taskId: OTHER, source: 'manual', linkedAt: 100 });

  /* When */
  const wins = detectedLinkWins(current, { taskId: TASK, at: 50 });

  /* Then */
  assert.equal(wins, false);
});

test('the task the session is linked to already is no news', () => {
  /* Given */
  const current = link('s1', { linkedAt: 100 });

  /* When */
  const wins = detectedLinkWins(current, { taskId: TASK, at: 200 });

  /* Then */
  assert.equal(wins, false);
});

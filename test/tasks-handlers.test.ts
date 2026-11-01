import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INVOKE } from '../src/ipc/channels';
import { registerTasksHandlers } from '../src/main/ipc/tasks-handlers';
import type { IpcRegistrar, InvokeHandler } from '../src/main/ipc/registrar';
import type { Container } from '../src/main/composition-root';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';

/** The registrar as main's: a thrown error answers `{ ok: false, error }`. */
function fakeIpc() {
  const handlers = new Map<string, InvokeHandler>();
  const ipc: IpcRegistrar = {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    on: () => {},
  };
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error('No handler for ' + channel);
    try {
      return await (handler as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  };
  return { ipc, invoke, channels: () => [...handlers.keys()] };
}

/** The tasks service, recording what each handler asked of it. */
function fakeTasks() {
  const calls: unknown[][] = [];
  const record = (name: string, answer: unknown = undefined) => (...args: unknown[]) => {
    calls.push([name, ...args]);
    return answer;
  };
  const tasks = {
    list: record('list', Promise.resolve({ kind: 'off' })),
    get: record('get', Promise.resolve({ kind: 'off' })),
    update: record('update', Promise.resolve({ kind: 'queued' })),
    setRepo: record('setRepo'),
    prepareStart: record('prepareStart', Promise.resolve({ kind: 'cancelled' })),
    sessionStarted: record('sessionStarted'),
    link: record('link', Promise.resolve()),
    unlink: record('unlink'),
    sessionTask: record('sessionTask', TASK),
    sessionTasks: record('sessionTasks', { s1: TASK }),
    taskSessions: record('taskSessions', { sessions: ['s1'], owner: 's1' }),
    projectTasks: record('projectTasks', [TASK]),
    watch: record('watch'),
    unwatch: record('unwatch'),
  };
  return { tasks: tasks as unknown as Container['tasks'], calls };
}

function setup() {
  const ipc = fakeIpc();
  const { tasks, calls } = fakeTasks();
  registerTasksHandlers(ipc.ipc, { tasks });
  return { ...ipc, calls };
}

test('every task channel has a handler', () => {
  /* Given */
  const { channels } = setup();

  /* When */
  const registered = channels().sort();

  /* Then */
  const tasks = Object.entries(INVOKE).filter(([key]) => key.startsWith('tasks')).map(([, channel]) => channel).sort();
  assert.deepEqual(registered, tasks);
});

test('a list is asked with its view and only the options a list takes', async () => {
  /* Given */
  const { invoke, calls } = setup();

  /* When */
  const answer = await invoke(INVOKE.tasksList, { view: 'due', options: { context: 'private', query: 'call', limit: 20, extra: 'x' } });

  /* Then */
  assert.deepEqual(answer, { kind: 'off' });
  assert.deepEqual(calls, [['list', { view: 'due', options: { context: 'private', query: 'call', limit: 20 } }]]);
});

test('a list that is not one is refused before it reaches the service', async () => {
  /* Given */
  const { invoke, calls } = setup();

  /* When */
  const answer = await invoke(INVOKE.tasksList, { view: 'everything' });

  /* Then */
  assert.equal((answer as { ok: boolean }).ok, false);
  assert.deepEqual(calls, []);
});

test('★, snooze and Done are passed on, and anything else is refused', async () => {
  /* Given */
  const { invoke, calls } = setup();

  /* When */
  await invoke(INVOKE.tasksUpdate, TASK, { kind: 'star', today: false });
  await invoke(INVOKE.tasksUpdate, TASK, { kind: 'snooze', until: null });
  await invoke(INVOKE.tasksUpdate, TASK, { kind: 'done' });
  const refused = await invoke(INVOKE.tasksUpdate, TASK, { kind: 'delete' });

  /* Then */
  assert.equal((refused as { ok: boolean }).ok, false);
  assert.deepEqual(calls, [
    ['update', TASK, { kind: 'star', today: false }],
    ['update', TASK, { kind: 'snooze', until: null }],
    ['update', TASK, { kind: 'done' }],
  ]);
});

test('preparing a start takes the task, the project and the existing-branch choice', async () => {
  /* Given */
  const { invoke, calls } = setup();

  /* When */
  await invoke(INVOKE.tasksPrepareStart, { task: { id: TASK, title: 'Fix the login', brief: 'It loops.', url: 'x' }, projectPath: '/code/app', existing: 'replace' });
  const refused = await invoke(INVOKE.tasksPrepareStart, { task: { id: TASK, title: 'Fix the login' }, existing: 'merge' });

  /* Then */
  assert.equal((refused as { ok: boolean }).ok, false);
  assert.deepEqual(calls, [['prepareStart', {
    task: { id: TASK, title: 'Fix the login', brief: 'It loops.' }, projectPath: '/code/app', existing: 'replace',
  }]]);
});

test('a started session, a link and an unlink are passed on and answer ok', async () => {
  /* Given */
  const { invoke, calls } = setup();

  /* When */
  const started = await invoke(INVOKE.tasksSessionStarted, TASK, 's1', '/code/app');
  const linked = await invoke(INVOKE.tasksLinkSession, 's2', TASK);
  const unlinked = await invoke(INVOKE.tasksUnlinkSession, 's2');
  const refused = await invoke(INVOKE.tasksSessionStarted, TASK, '', '/code/app');

  /* Then */
  assert.deepEqual([started, linked, unlinked], [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal((refused as { ok: boolean }).ok, false);
  assert.deepEqual(calls, [
    ['sessionStarted', TASK, 's1', '/code/app'],
    ['link', 's2', TASK],
    ['unlink', 's2'],
  ]);
});

test('the link reads answer what the service says', async () => {
  /* Given */
  const { invoke } = setup();

  /* When */
  const answers = [
    await invoke(INVOKE.tasksSessionTask, 's1'),
    await invoke(INVOKE.tasksSessionTasks),
    await invoke(INVOKE.tasksTaskSessions, TASK),
    await invoke(INVOKE.tasksProjectTasks, '/code/app'),
  ];

  /* Then */
  assert.deepEqual(answers, [TASK, { s1: TASK }, { sessions: ['s1'], owner: 's1' }, [TASK]]);
});

test('watching a list, watching for the poll only, and unwatching', async () => {
  /* Given */
  const { invoke, calls } = setup();

  /* When */
  await invoke(INVOKE.tasksWatch, 'page', { view: 'today' });
  await invoke(INVOKE.tasksWatch, 'tab', null);
  await invoke(INVOKE.tasksUnwatch, 'page');

  /* Then */
  assert.deepEqual(calls, [['watch', 'page', { view: 'today' }], ['watch', 'tab', null], ['unwatch', 'page']]);
});

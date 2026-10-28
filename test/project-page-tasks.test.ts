/**
 * The project page's Tasks section (#251): which of the repo's linked tasks
 * it lists, the project-page slice keeping them (and following the Tasks
 * page's row keys), the cursor rows and keys it adds, and reading them from
 * main against a fake `window.api`, never while BlaakTasks is off.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, getState } from '../src/renderer/state/app-store';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { NO_MEMORY } from '../src/renderer/state/project-page-slice';
import {
  PROJECT_TASKS_ASKED, cursorId, isOpenTask, localDay, pageRows, projectTaskRows, sessionRows, taskRows, tasksViewOf,
} from '../src/renderer/ui/project-page/page-rows';
import { pageKeyAction } from '../src/renderer/ui/project-page/page-keys';
import { loadProjectTasks, startProjectTask, tasksRequest } from '../src/renderer/ui/project-page/project-tasks';
import { setTasksPageEffects } from '../src/renderer/ui/tasks-page/actions';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { BlaakTasksResult, TaskDetail, TaskRow } from '../src/domain/tasks/model';
import type { StartTaskSessionRequest } from '../src/renderer/ui/tasks/start-task-session';

const APP = '/dev/app';
const TODAY = '2026-10-28';

function task(id: string, patch: Partial<TaskRow> = {}): TaskRow {
  return {
    id, context: 'work', title: 'Task ' + id, summary: null, status: 'Not started', deadline: null, dueLabel: null,
    today: false, effort: null, bucket: null, client: null, topic: null, waitingOn: null, snoozedUntil: null,
    lastUpdate: null, pullRequests: [], ...patch,
  };
}

function detail(row: TaskRow): TaskDetail {
  return { ...row, notes: null, url: 'https://www.notion.so/' + row.id, brief: 'The idea', progress: [] };
}

const ok = (row: TaskRow): BlaakTasksResult<TaskDetail> => ({ kind: 'ok', value: detail(row) });

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

/** The page open on APP, BlaakTasks on, its tasks answered. */
function withTasks(rows: TaskRow[], sessions: Record<string, number> = {}): RendererState {
  return run(
    initialRendererState(),
    { type: 'blaakTasksSwitched', on: true },
    { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY },
    { type: 'projectTasksAnswered', projectPath: APP, rows, sessions },
  );
}

/** A main that answers each call by its method's handler, recording every call. */
function installMain(handlers: Record<string, (...args: any[]) => unknown>): { calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  const api = new Proxy({}, {
    get: (_target, method: string) => async (...args: unknown[]) => {
      calls.push([method, ...args]);
      const handler = handlers[method];
      return handler ? handler(...args) : undefined;
    },
  });
  Object.assign(globalThis, { window: { api } });
  return { calls };
}

// ── Which tasks it lists ──

test('only open tasks show, newest link first: Done, Dropped and snoozed past today are left out', () => {
  /* Given */
  const ids = ['new', 'done', 'dropped', 'snoozed', 'woke', 'old'];
  const answers = [
    ok(task('new', { status: 'In progress' })),
    ok(task('done', { status: 'Done' })),
    ok(task('dropped', { status: 'Dropped' })),
    ok(task('snoozed', { snoozedUntil: '2026-10-29' })),
    ok(task('woke', { snoozedUntil: '2026-10-28T09:00' })),
    ok(task('old', { status: 'Waiting' })),
  ];

  /* When */
  const rows = projectTaskRows(ids, answers, [], TODAY);

  /* Then */
  assert.deepEqual(rows.map(row => row.id), ['new', 'woke', 'old']);
  assert.equal('brief' in rows[0], false);
});

test('a task BlaakTasks did not answer for keeps the row it had, and one it never had is left out', () => {
  /* Given */
  const previous = [task('a', { status: 'In progress' })];
  const answers: BlaakTasksResult<TaskDetail>[] = [
    { kind: 'unreachable', reason: 'timeout' },
    { kind: 'failed', reason: 'Unknown id' },
  ];

  /* When */
  const rows = projectTaskRows(['a', 'b'], answers, previous, TODAY);

  /* Then */
  assert.deepEqual(rows, previous);
});

test('a task is open until it is Done or Dropped', () => {
  /* Given */
  const statuses = ['Not started', 'In progress', 'Waiting', 'Done', 'Dropped'] as const;

  /* When */
  const open = statuses.map(status => isOpenTask(task('a', { status }), TODAY));

  /* Then */
  assert.deepEqual(open, [true, true, true, false, false]);
});

test('the day is the local one', () => {
  /* Given */
  const lateEvening = new Date(2026, 9, 28, 23, 30);

  /* When */
  const day = localDay(lateEvening);

  /* Then */
  assert.equal(day, '2026-10-28');
});

// ── The section in the slice ──

test('the section is left out before an answer, for another project, and with no open task linked', () => {
  /* Given */
  const before = run(initialRendererState(), { type: 'blaakTasksSwitched', on: true }, { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });
  const empty = withTasks([]);
  const other = run(initialRendererState(), { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY }, { type: 'projectTasksAnswered', projectPath: '/dev/api', rows: [task('a')], sessions: {} });

  /* When */
  const views = [before, empty, other].map(state => tasksViewOf(state.projectPage, APP));

  /* Then */
  assert.deepEqual(views, [null, null, null]);
});

test('the filter narrows the tasks by title, summary, bucket or client', () => {
  /* Given */
  const state = run(
    withTasks([task('a', { title: 'Fix the login', client: 'Acme' }), task('b', { summary: 'Release notes' })]),
    { type: 'projectFilterChanged', filter: 'acme' },
  );

  /* When */
  const shown = tasksViewOf(state.projectPage, APP);

  /* Then */
  assert.deepEqual(shown?.map(row => row.id), ['a']);
});

test('switching BlaakTasks off forgets the tasks; the same project opening again keeps them, another drops them', () => {
  /* Given */
  const state = withTasks([task('a')]);

  /* When */
  const off = run(state, { type: 'blaakTasksSwitched', on: false });
  const again = run(state, { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });
  const other = run(state, { type: 'projectPageRestored', projectPath: '/dev/api', memory: NO_MEMORY });

  /* Then */
  assert.equal(off.projectPage.tasks, null);
  assert.deepEqual(again.projectPage.tasks?.rows.map(row => row.id), ['a']);
  assert.equal(other.projectPage.tasks, null);
});

test('an answer for another project than the open one is old news', () => {
  /* Given */
  const state = withTasks([task('a')]);

  /* When */
  const next = run(state, { type: 'projectTasksAnswered', projectPath: '/dev/api', rows: [task('b')], sessions: {} });

  /* Then */
  assert.deepEqual(next.projectPage.tasks?.rows.map(row => row.id), ['a']);
});

test('★ changes the row in place; Done or snooze takes it off, the cursor staying on the same spot', () => {
  /* Given */
  const state = run(withTasks([task('a'), task('b'), task('c')]), { type: 'projectCursorMoved', target: cursorId.task('b') });

  /* When */
  const starred = run(state, { type: 'tasksRowChanged', taskId: 'a', row: task('a', { today: true }) });
  const done = run(starred, { type: 'tasksRowChanged', taskId: 'b', row: null });

  /* Then */
  assert.equal(starred.projectPage.tasks?.rows[0].today, true);
  assert.deepEqual(done.projectPage.tasks?.rows.map(row => row.id), ['a', 'c']);
  assert.equal(done.projectPage.cursor, cursorId.task('c'));
});

test('a page opening on a project starts with no task start, detail or notice left over', () => {
  /* Given */
  const state = run(
    initialRendererState(),
    { type: 'blaakTasksSwitched', on: true },
    { type: 'tasksStartAsked', taskId: 'a' },
    { type: 'tasksNoticed', notice: { text: 'Done', tone: 'info' } },
    { type: 'tasksDetailOpened', taskId: 'a' },
  );

  /* When */
  const opened = run(state, { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });

  /* Then */
  assert.equal(opened.tasks.start, null);
  assert.equal(opened.tasks.detail, null);
  assert.equal(opened.tasks.notice, null);
});

// ── The cursor and the keys ──

test('the cursor walks the tasks after Pull requests and before Sessions', () => {
  /* Given */
  const tasks = taskRows([task('a'), task('b')]);

  /* When */
  const rows = pageRows({ plans: [], pullRequests: [], tasks, sessions: sessionRows(['s1']) });

  /* Then */
  assert.deepEqual(rows.map(row => row.id), ['task:a', 'task:b', 'session:s1']);
});

test('the Tasks page\'s keys work on the task under the cursor', () => {
  /* Given */
  const rows = taskRows([task('a')]);
  const keys = ['S', 's', '*', 'D', 'z', 'O', 'Enter', 'x', 'ArrowRight'];

  /* When */
  const actions = keys.map(key => pageKeyAction(key, rows, cursorId.task('a')));

  /* Then */
  assert.deepEqual(actions, [
    { kind: 'task', key: 'start', taskId: 'a' },
    { kind: 'task', key: 'start', taskId: 'a' },
    { kind: 'task', key: 'star', taskId: 'a' },
    { kind: 'task', key: 'done', taskId: 'a' },
    { kind: 'task', key: 'snooze', taskId: 'a' },
    { kind: 'task', key: 'notion', taskId: 'a' },
    { kind: 'task', key: 'detail', taskId: 'a' },
    null,
    null,
  ]);
});

// ── Reading them, and starting ──

beforeEach(() => {
  dispatch({ type: 'blaakTasksSwitched', on: false });
  dispatch({ type: 'projectPageRestored', projectPath: '/dev/elsewhere', memory: NO_MEMORY });
  installMain({});
});

test('nothing is read while BlaakTasks is off', async () => {
  /* Given */
  dispatch({ type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });
  const main = installMain({ projectTasks: () => ['a'] });

  /* When */
  await loadProjectTasks(APP);

  /* Then */
  assert.deepEqual(main.calls, []);
});

test('the tasks are read for the project whose overview is on screen, only while BlaakTasks is on', () => {
  /* Given */
  const open = run(
    initialRendererState(),
    { type: 'projectOpened', projectPath: APP, view: { kind: 'overview' } },
    { type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY },
  );

  /* When */
  const off = tasksRequest(open);
  const on = tasksRequest(run(open, { type: 'blaakTasksSwitched', on: true }));
  const settings = tasksRequest(run(open, { type: 'blaakTasksSwitched', on: true }, { type: 'projectOpened', projectPath: APP, view: { kind: 'settings' } }));

  /* Then */
  assert.equal(off, null);
  assert.equal(on, APP);
  assert.equal(settings, null);
});

test('the repo\'s linked tasks are asked, newest first and at most a few, with their sessions counted', async () => {
  /* Given */
  dispatch({ type: 'blaakTasksSwitched', on: true });
  dispatch({ type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });
  const linked = Array.from({ length: PROJECT_TASKS_ASKED + 5 }, (_, i) => 't' + i);
  const main = installMain({
    projectTasks: () => linked,
    sessionTasks: () => ({ s1: 't0', s2: 't0', s3: 't1', s4: 'elsewhere' }),
    getTask: (id: string) => ok(task(id, { status: id === 't1' ? 'Done' : 'In progress' })),
  });

  /* When */
  await loadProjectTasks(APP, new Date(2026, 9, 28, 10));

  /* Then */
  const asked = main.calls.filter(([method]) => method === 'getTask').map(([, id]) => id);
  assert.deepEqual(asked, linked.slice(0, PROJECT_TASKS_ASKED));
  assert.deepEqual(main.calls[0], ['projectTasks', APP]);
  const tasks = getState().projectPage.tasks;
  assert.deepEqual(tasks?.rows.slice(0, 2).map(row => row.id), ['t0', 't2']);
  assert.deepEqual(tasks?.sessions, { t0: 2 });
});

test('S starts in this repo with no routing, in the background, and its new row pulses', async () => {
  /* Given */
  dispatch({ type: 'blaakTasksSwitched', on: true });
  dispatch({ type: 'projectPageRestored', projectPath: APP, memory: NO_MEMORY });
  const main = installMain({ projectTasks: () => [], sessionTasks: () => ({}) });
  const starts: StartTaskSessionRequest[] = [];
  const pulsed: string[] = [];
  setTasksPageEffects({
    startSession: async (request) => { starts.push(request); return { kind: 'started', sessionId: 's9', projectPath: APP }; },
    pulse: (id) => pulsed.push(id),
    openSession: () => {},
    projects: () => [],
    now: () => new Date(2026, 9, 28, 10),
  });

  /* When */
  await startProjectTask(APP, task('a'));

  /* Then */
  assert.deepEqual(starts, [{ task: { id: 'a', title: 'Task a' }, projectPath: APP, show: false }]);
  assert.deepEqual(pulsed, ['s9']);
  assert.equal(main.calls.some(([method]) => method === 'getTask'), false);
  const start = getState().tasks.start;
  assert.equal(start?.phase === 'answered' && start.routed, false);
});

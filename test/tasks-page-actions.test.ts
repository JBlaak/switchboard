/**
 * What the Tasks page does (#249), against a fake `window.api` and fake
 * effects: the switch, the row keys, the links it reads, and each way a
 * start can end. Also what a row says and which key does what.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, getState } from '../src/renderer/state/app-store';
import { TASKS_PAGE_WATCH, visibleRows } from '../src/renderer/state/tasks-slice';
import {
  followBlaakTasksSwitch, loadTaskLinks, markTaskDone, openTaskDetail, openTaskInNotion, openTasksPage, pickProject,
  askStartInstructions, setTasksPageEffects, snoozeTask, starTask, startFromTask, taskProjects, toggleTasksPage, type TasksPageEffects,
} from '../src/renderer/ui/tasks-page/actions';
import { tasksKeyAction } from '../src/renderer/ui/tasks-page/page-keys';
import { statusTone, taskMeta } from '../src/renderer/ui/tasks/task-row';
import type { Project } from '../src/domain/project/project';
import type { TaskDetail, TaskRow } from '../src/domain/tasks/model';
import type { TaskSessionStart } from '../src/domain/tasks/surface';
import type { StartTaskSessionRequest } from '../src/renderer/ui/tasks/start-task-session';

function task(id: string, patch: Partial<TaskRow> = {}): TaskRow {
  return {
    id, context: 'work', title: 'Task ' + id, summary: null, status: 'Not started', deadline: null, dueLabel: null,
    today: false, effort: null, bucket: null, client: null, topic: null, waitingOn: null, snoozedUntil: null,
    lastUpdate: null, pullRequests: [], ...patch,
  };
}

function detail(row: TaskRow, brief = ''): TaskDetail {
  return { ...row, notes: null, url: 'https://www.notion.so/' + row.id, brief, progress: [] };
}

const project = (projectPath: string, remote = false): Project => ({ projectPath, folder: projectPath, sessions: [], remote });

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

/** Effects that record what the page asked of the rest of the renderer, starting with `answer`. */
function installEffects(answer: (request: StartTaskSessionRequest) => TaskSessionStart, projects: Project[] = []) {
  const seen = { starts: [] as StartTaskSessionRequest[], pulsed: [] as string[], opened: [] as string[] };
  const effects: TasksPageEffects = {
    startSession: async (request) => { seen.starts.push(request); return answer(request); },
    pulse: (id) => seen.pulsed.push(id),
    openSession: (id) => seen.opened.push(id),
    projects: () => projects,
    now: () => new Date(2026, 9, 28, 10),
  };
  setTasksPageEffects(effects);
  return seen;
}

/** The page on, open, showing `rows` in ★ Today. */
function showing(rows: TaskRow[]): void {
  dispatch({ type: 'blaakTasksSwitched', on: true });
  dispatch({ type: 'tasksOpened' });
  dispatch({ type: 'tasksChanged', update: { watchId: TASKS_PAGE_WATCH, query: { view: 'today', options: { context: 'work' } }, state: 'ok', rows, fetchedAt: 1 } });
}

const ids = () => visibleRows(getState().tasks).map(row => row.id);

beforeEach(() => {
  dispatch({ type: 'blaakTasksSwitched', on: false });
  installMain({});
  installEffects(() => ({ kind: 'cancelled' }));
});

test('the page opens only while a BlaakTasks URL is set', () => {
  /* Given */
  followBlaakTasksSwitch({ blaakTasksUrl: '  ' });

  /* When */
  openTasksPage();
  const whileOff = getState().mainArea.route.kind;
  followBlaakTasksSwitch({ blaakTasksUrl: 'https://tasks.example.com/mcp' });
  toggleTasksPage();

  /* Then */
  assert.equal(whileOff, 'empty');
  assert.equal(getState().tasks.enabled, true);
  assert.equal(getState().mainArea.route.kind, 'tasks');
});

test('★ stars the row at once and keeps what BlaakTasks answers', async () => {
  /* Given */
  showing([task('a')]);
  const main = installMain({ updateTask: (_id, change) => ({ kind: 'ok', value: task('a', { today: change.today, status: 'In progress' }) }) });

  /* When */
  await starTask(task('a'));

  /* Then */
  assert.deepEqual(main.calls, [['updateTask', 'a', { kind: 'star', today: true }]]);
  assert.deepEqual(visibleRows(getState().tasks)[0], task('a', { today: true, status: 'In progress' }));
});

test('★ that BlaakTasks refuses puts the row back and says why', async () => {
  /* Given */
  showing([task('a')]);
  installMain({ updateTask: () => ({ kind: 'unreachable', reason: 'timeout' }) });

  /* When */
  await starTask(task('a'));

  /* Then */
  assert.equal(visibleRows(getState().tasks)[0].today, false);
  assert.equal(getState().tasks.notice?.tone, 'error');
  assert.match(getState().tasks.notice!.text, /Couldn't reach BlaakTasks/);
});

test('D marks the task done and takes it off the list, also when it is queued for the next try', async () => {
  /* Given */
  showing([task('a'), task('b')]);
  const main = installMain({ updateTask: (id) => (id === 'a' ? { kind: 'ok', value: null } : { kind: 'queued' }) });

  /* When */
  await markTaskDone(task('a'));
  await markTaskDone(task('b'));

  /* Then */
  assert.deepEqual(main.calls, [['updateTask', 'a', { kind: 'done' }], ['updateTask', 'b', { kind: 'done' }]]);
  assert.deepEqual(ids(), []);
});

test('Z snoozes the task to tomorrow and takes it off the list', async () => {
  /* Given */
  showing([task('a')]);
  const main = installMain({ updateTask: () => ({ kind: 'ok', value: task('a', { snoozedUntil: '2026-10-29' }) }) });

  /* When */
  await snoozeTask(task('a'));

  /* Then */
  assert.deepEqual(main.calls, [['updateTask', 'a', { kind: 'snooze', until: '2026-10-29' }]]);
  assert.deepEqual(ids(), []);
});

test('O opens the task\'s Notion page', async () => {
  /* Given */
  showing([task('a')]);
  const main = installMain({ getTask: () => ({ kind: 'ok', value: detail(task('a')) }) });

  /* When */
  await openTaskInNotion('a');

  /* Then */
  assert.deepEqual(main.calls, [['getTask', 'a'], ['openExternal', 'https://www.notion.so/a']]);
});

test('Enter opens the detail with the task, its sessions and their owner', async () => {
  /* Given */
  showing([task('a')]);
  installMain({
    getTask: () => ({ kind: 'ok', value: detail(task('a'), 'The full idea') }),
    taskSessions: () => ({ sessions: ['s2', 's1'], owner: 's2' }),
  });

  /* When */
  await openTaskDetail('a');

  /* Then */
  const shown = getState().tasks.detail;
  assert.equal(shown?.detail?.brief, 'The full idea');
  assert.deepEqual(shown?.sessions, { sessions: ['s2', 's1'], owner: 's2' });
});

test('the links give each task its repo and how many sessions worked on it', async () => {
  /* Given */
  showing([task('a'), task('b')]);
  installEffects(() => ({ kind: 'cancelled' }), [
    project('/dev/app'), project('/dev/app/.claude/worktrees/fix-it'), project('/dev/api'), project('ssh://box/srv', true),
  ]);
  const main = installMain({
    projectTasks: (path) => (path === '/dev/app' ? ['a'] : []),
    sessionTasks: () => ({ s1: 'a', s2: 'a', s3: 'b' }),
  });

  /* When */
  await loadTaskLinks();

  /* Then */
  assert.deepEqual(main.calls.filter(([method]) => method === 'projectTasks').map(([, path]) => path), ['/dev/app', '/dev/api']);
  assert.deepEqual(getState().tasks.links, { repos: { a: '/dev/app' }, sessions: { a: 2, b: 1 } });
});

test('S on a task with a repo starts there in the background, and its new row pulses', async () => {
  /* Given */
  showing([task('a')]);
  dispatch({ type: 'tasksLinksLoaded', links: { repos: { a: '/dev/app' }, sessions: {} } });
  const main = installMain({ projectTasks: () => [], sessionTasks: () => ({}) });
  const seen = installEffects(() => ({ kind: 'started', sessionId: 's9', projectPath: '/dev/app' }));

  /* When */
  await startFromTask(task('a'));

  /* Then */
  assert.deepEqual(seen.starts, [{ task: { id: 'a', title: 'Task a' }, show: false }]);
  assert.deepEqual(seen.pulsed, ['s9']);
  assert.equal(main.calls.some(([method]) => method === 'getTask'), false);
  const start = getState().tasks.start;
  assert.equal(start?.phase === 'answered' && start.routed, false);
  assert.equal(getState().mainArea.route.kind, 'tasks');
});

test('S on a task with no repo hands Patch its brief, and a confident start says where Patch put it', async () => {
  /* Given */
  showing([task('a')]);
  installMain({ getTask: () => ({ kind: 'ok', value: detail(task('a'), 'Crashes on export') }), projectTasks: () => [], sessionTasks: () => ({}) });
  const seen = installEffects(() => ({ kind: 'started', sessionId: 's9', projectPath: '/dev/app' }));

  /* When */
  await startFromTask(task('a'));

  /* Then */
  assert.deepEqual(seen.starts[0].task, { id: 'a', title: 'Task a', brief: 'Crashes on export' });
  const start = getState().tasks.start;
  assert.ok(start?.phase === 'answered' && start.routed && start.outcome.kind === 'started');
});

test('S asks for instructions first, and the start hands them on to the session', async () => {
  /* Given */
  showing([task('a')]);
  dispatch({ type: 'tasksLinksLoaded', links: { repos: { a: '/dev/app' }, sessions: {} } });
  installMain({ projectTasks: () => [], sessionTasks: () => ({}) });
  const seen = installEffects(() => ({ kind: 'started', sessionId: 's9', projectPath: '/dev/app' }));

  /* When */
  askStartInstructions(task('a'));
  const asked = getState().tasks.start;
  await startFromTask(task('a'), { instructions: ' Only the API ' });

  /* Then */
  assert.deepEqual(asked, { taskId: 'a', phase: 'instructing' });
  assert.deepEqual(seen.starts, [{ task: { id: 'a', title: 'Task a', instructions: 'Only the API' }, show: false }]);
});

test('a choice from a start\'s answer starts with the instructions the start had', async () => {
  /* Given */
  showing([task('a')]);
  installMain({ getTask: () => ({ kind: 'ok', value: detail(task('a'), '') }), projectTasks: () => [], sessionTasks: () => ({}) });
  const seen = installEffects(request => request.projectPath
    ? { kind: 'started', sessionId: 's9', projectPath: request.projectPath }
    : { kind: 'unsure', candidates: ['/dev/app', '/dev/api'] });
  await startFromTask(task('a'), { instructions: 'Only the API' });

  /* When */
  await startFromTask(task('a'), { projectPath: '/dev/api' });

  /* Then */
  assert.deepEqual(seen.starts.map(start => start.task.instructions), ['Only the API', 'Only the API']);
});

test('Patch unsure offers its candidates; picking one starts there', async () => {
  /* Given */
  showing([task('a')]);
  installMain({ getTask: () => ({ kind: 'failed', reason: 'no' }), projectTasks: () => [], sessionTasks: () => ({}) });
  const seen = installEffects((request) => (request.projectPath
    ? { kind: 'started', sessionId: 's9', projectPath: request.projectPath }
    : { kind: 'unsure', candidates: ['/dev/app', '/dev/sdk', '/dev/api'] }));

  /* When */
  await startFromTask(task('a'));
  const unsure = getState().tasks.start;
  await pickProject(task('a'), '/dev/sdk');

  /* Then */
  assert.ok(unsure?.phase === 'answered' && unsure.outcome.kind === 'unsure');
  assert.deepEqual(seen.starts.map(request => request.projectPath), [undefined, '/dev/sdk']);
  assert.deepEqual(seen.pulsed, ['s9']);
});

test('no match opens the project list, and the project picked there is started in', async () => {
  /* Given */
  showing([task('a')]);
  installMain({ getTask: () => ({ kind: 'failed', reason: 'no' }), projectTasks: () => [], sessionTasks: () => ({}) });
  const seen = installEffects((request) => (request.projectPath
    ? { kind: 'started', sessionId: 's9', projectPath: request.projectPath }
    : { kind: 'noMatch', reason: 'No project fits' }));

  /* When */
  await startFromTask(task('a'));
  const picker = getState().tasks.picker;
  await pickProject(task('a'), '/dev/api');

  /* Then */
  assert.deepEqual(picker, { taskId: 'a', purpose: 'start' });
  assert.equal(seen.starts[1].projectPath, '/dev/api');
  assert.equal(getState().tasks.picker, null);
});

test('an existing branch is offered again with the choice: Continue reuses it in the same repo', async () => {
  /* Given */
  showing([task('a')]);
  dispatch({ type: 'tasksLinksLoaded', links: { repos: { a: '/dev/app' }, sessions: {} } });
  installMain({ projectTasks: () => [], sessionTasks: () => ({}) });
  const existing = { branch: 'task-a', worktreePath: '/dev/app/.claude/worktrees/task-a', main: false, changedFiles: 2, ahead: 3, sessionId: 's1' };
  const seen = installEffects((request) => (request.existing
    ? { kind: 'started', sessionId: 's9', projectPath: '/dev/app' }
    : { kind: 'existing', projectPath: '/dev/app', reason: 'exists', existing }));

  /* When */
  await startFromTask(task('a'));
  const asked = getState().tasks.start;
  await startFromTask(task('a'), { projectPath: '/dev/app', existing: 'reuse' });

  /* Then */
  assert.ok(asked?.phase === 'answered' && asked.outcome.kind === 'existing');
  assert.deepEqual(seen.starts[1], { task: { id: 'a', title: 'Task a' }, projectPath: '/dev/app', existing: 'reuse', show: false });
});

test('Change repo links the task to the project picked, and the links are read again', async () => {
  /* Given */
  showing([task('a')]);
  installEffects(() => ({ kind: 'cancelled' }), [project('/dev/api')]);
  dispatch({ type: 'tasksPickerOpened', taskId: 'a', purpose: 'repo' });
  const main = installMain({ setTaskRepo: () => ({ ok: true }), projectTasks: () => ['a'], sessionTasks: () => ({}) });

  /* When */
  await pickProject(task('a'), '/dev/api');

  /* Then */
  assert.deepEqual(main.calls[0], ['setTaskRepo', 'a', '/dev/api']);
  assert.equal(getState().tasks.links.repos.a, '/dev/api');
});

test('the project list offers each local repository once, never a remote one', () => {
  /* Then */
  assert.deepEqual(taskProjects([
    project('/dev/app'), project('/dev/app/.claude/worktrees/x'), project('ssh://box/srv', true), project('/dev/api'),
  ]), ['/dev/app', '/dev/api']);
});

test('every key acts on the row under the cursor, or the first while it is on none', () => {
  /* Given */
  const rows = [task('a'), task('b')];

  /* Then */
  assert.deepEqual(tasksKeyAction('ArrowDown', rows, null), { kind: 'cursor', taskId: 'b' });
  assert.deepEqual(tasksKeyAction('k', rows, 'b'), { kind: 'cursor', taskId: 'a' });
  for (const [key, kind] of [['S', 'start'], ['s', 'start'], ['*', 'star'], ['d', 'done'], ['z', 'snooze'], ['o', 'notion'], ['Enter', 'detail']] as const) {
    assert.deepEqual(tasksKeyAction(key, rows, 'b'), { kind, task: rows[1] }, key);
  }
  assert.deepEqual(tasksKeyAction('S', rows, null), { kind: 'start', task: rows[0] });
  assert.equal(tasksKeyAction('S', [], null), null);
  assert.equal(tasksKeyAction('x', rows, 'a'), null);
});

test('a row says its context, its repo or that it has none, its sessions and when it is due', () => {
  /* Then */
  assert.equal(taskMeta(task('a', { bucket: 'Customer', client: 'Acme' }), null, 0), 'Customer · Acme · no project yet');
  assert.equal(taskMeta(task('a', { client: 'Acme', dueLabel: 'Fri 2 Oct' }), 'switchboard', 1), 'Acme · switchboard · 1 session · due Fri 2 Oct');
  assert.equal(taskMeta(task('a', { bucket: 'Admin' }), 'x', 3, { showRepo: false }), 'Admin · 3 sessions');
  assert.equal(statusTone('In progress'), 'in-progress');
});

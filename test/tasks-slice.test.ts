/**
 * The Tasks page's state (#249): the BlaakTasks switch and the route, the
 * query each view asks, the list main pushes (kept through an outage), the
 * cursor, and a start's answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import {
  TASKS_PAGE_WATCH, cursorRow, listAnswered, queryKey, tasksQuery, tomorrow, visibleRows,
} from '../src/renderer/state/tasks-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { TaskRow } from '../src/domain/tasks/model';
import type { TaskQuery, TasksUpdate } from '../src/domain/tasks/surface';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function task(id: string, patch: Partial<TaskRow> = {}): TaskRow {
  return {
    id, context: 'work', title: 'Task ' + id, summary: null, status: 'Not started', deadline: null, dueLabel: null,
    today: false, effort: null, bucket: null, client: null, topic: null, waitingOn: null, snoozedUntil: null,
    lastUpdate: null, pullRequests: [], ...patch,
  };
}

const TODAY: TaskQuery = { view: 'today', options: { context: 'work' } };

function pushed(query: TaskQuery, rows: TaskRow[], state: TasksUpdate['state'] = 'ok', watchId = TASKS_PAGE_WATCH): RendererEvent {
  return { type: 'tasksChanged', update: { watchId, query, state, rows, fetchedAt: state === 'ok' ? 1000 : 500 } };
}

const on = (): RendererState => run(initialRendererState(), { type: 'blaakTasksSwitched', on: true });

test('the page does not open while BlaakTasks is off, and opens once it is on', () => {
  /* Given */
  const off = initialRendererState();

  /* When */
  const opened = run(on(), { type: 'tasksOpened' });

  /* Then */
  assert.equal(off.tasks.enabled, false);
  assert.equal(opened.mainArea.route.kind, 'tasks');
});

test('closing the page goes back to the session it covered', () => {
  /* Given */
  const state = run(on(),
    { type: 'activeSessionChanged', sessionId: 's1' }, { type: 'sessionShown', sessionId: 's1', name: 's1' },
    { type: 'tasksOpened' });

  /* When */
  const closed = run(state, { type: 'tasksClosed' });

  /* Then */
  assert.deepEqual(closed.mainArea.route, { kind: 'session', sessionId: 's1' });
});

test('switching BlaakTasks off closes the page and forgets its list', () => {
  /* Given */
  const state = run(on(), { type: 'tasksOpened' }, pushed(TODAY, [task('a')]));

  /* When */
  const off = run(state, { type: 'blaakTasksSwitched', on: false });

  /* Then */
  assert.equal(off.mainArea.route.kind, 'empty');
  assert.equal(off.tasks.enabled, false);
  assert.equal(off.tasks.list, null);
});

test('each view asks its own query, Work by default, and a search with nothing typed asks nothing', () => {
  /* Given */
  const base = { context: 'work' as const, search: '' };

  /* Then */
  assert.deepEqual(tasksQuery({ ...base, tab: 'today' }), TODAY);
  assert.deepEqual(tasksQuery({ ...base, tab: 'inProgress' }), TODAY);
  assert.deepEqual(tasksQuery({ ...base, tab: 'due' }), { view: 'due', options: { context: 'work' } });
  assert.deepEqual(tasksQuery({ ...base, tab: 'quick', context: 'private' }), { view: 'quick', options: { context: 'private' } });
  assert.equal(tasksQuery({ ...base, tab: 'search', search: '  ' }), null);
  assert.deepEqual(tasksQuery({ ...base, tab: 'search', search: ' export ' }), { view: 'today', options: { context: 'work', query: 'export' } });
  assert.equal(initialRendererState().tasks.context, 'work');
});

test('In progress keeps only the Today rows that are in progress', () => {
  /* Given */
  const state = run(on(), pushed(TODAY, [task('a', { status: 'In progress' }), task('b', { today: true })]));

  /* When */
  const progress = run(state, { type: 'tasksTabChosen', tab: 'inProgress' });

  /* Then */
  assert.deepEqual(visibleRows(state.tasks).map(row => row.id), ['a', 'b']);
  assert.deepEqual(visibleRows(progress.tasks).map(row => row.id), ['a']);
});

test('an answer to another watch, or to a query the page moved on from, is not shown', () => {
  /* Given */
  const state = run(on(), { type: 'tasksTabChosen', tab: 'due' });

  /* When */
  const next = run(state, pushed(TODAY, [task('a')]), pushed({ view: 'due', options: { context: 'work' } }, [task('b')], 'ok', 'project:x'));

  /* Then */
  assert.equal(listAnswered(next.tasks), false);
  assert.deepEqual(visibleRows(next.tasks), []);
});

test('an outage keeps the last rows and says so', () => {
  /* Given */
  const state = run(on(), pushed(TODAY, [task('a'), task('b')]));

  /* When */
  const down = run(state, pushed(TODAY, [task('a'), task('b')], 'unreachable'));

  /* Then */
  assert.equal(down.tasks.list?.state, 'unreachable');
  assert.deepEqual(visibleRows(down.tasks).map(row => row.id), ['a', 'b']);
});

test('the cursor starts on the first row, and a row that leaves hands it to the next', () => {
  /* Given */
  const state = run(on(), pushed(TODAY, [task('a'), task('b'), task('c')]));
  const onB = run(state, { type: 'tasksCursorMoved', taskId: 'b' });

  /* When */
  const done = run(onB, { type: 'tasksRowChanged', taskId: 'b', row: null });

  /* Then */
  assert.equal(cursorRow(state.tasks)?.id, 'a');
  assert.equal(done.tasks.cursor, 'c');
  assert.deepEqual(visibleRows(done.tasks).map(row => row.id), ['a', 'c']);
});

test('a changed row takes its place in the list', () => {
  /* Given */
  const state = run(on(), pushed(TODAY, [task('a'), task('b')]));

  /* When */
  const starred = run(state, { type: 'tasksRowChanged', taskId: 'b', row: task('b', { today: true }) });

  /* Then */
  assert.deepEqual(visibleRows(starred.tasks).map(row => row.today), [false, true]);
});

test('no match from Patch opens the project list for the task; dismissing puts both away', () => {
  /* Given */
  const state = run(on(), { type: 'tasksStartAsked', taskId: 'a' });

  /* When */
  const answered = run(state, { type: 'tasksStartAnswered', taskId: 'a', outcome: { kind: 'noMatch', reason: 'Nothing fits' }, routed: true });
  const dismissed = run(answered, { type: 'tasksStartDismissed' });

  /* Then */
  assert.equal(state.tasks.start?.phase, 'starting');
  assert.deepEqual(answered.tasks.picker, { taskId: 'a', purpose: 'start' });
  assert.equal(dismissed.tasks.start, null);
  assert.equal(dismissed.tasks.picker, null);
});

test('opening the page again starts with nothing left open from last time', () => {
  /* Given */
  const state = run(on(), { type: 'tasksOpened' }, { type: 'tasksDetailOpened', taskId: 'a' }, { type: 'tasksTabChosen', tab: 'due' }, { type: 'tasksClosed' });

  /* When */
  const again = run(state, { type: 'tasksOpened' });

  /* Then */
  assert.equal(again.tasks.detail, null);
  assert.equal(again.tasks.tab, 'due');
});

test('a query is spelled the same however its options are written', () => {
  /* Then */
  assert.equal(queryKey({ view: 'today', options: { context: 'work' } }), queryKey({ view: 'today', options: { context: 'work', query: undefined } }));
  assert.notEqual(queryKey(TODAY), queryKey({ view: 'today', options: { context: 'private' } }));
});

test('Z snoozes until the next local day, across a month end', () => {
  /* Then */
  assert.equal(tomorrow(new Date(2026, 9, 31, 23, 30)), '2026-11-01');
  assert.equal(tomorrow(new Date(2026, 1, 3, 8)), '2026-02-04');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  initialSessionTaskState, offerQuestion, rekeySessionTask, sessionTaskOf, sessionTaskReducer, statusTone, taskIdOf,
  taskPullRequestPills, tomorrow, writtenBySwitchboard,
} from '../src/renderer/state/session-task-slice';
import type { SessionTaskState } from '../src/renderer/state/session-task-slice';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import { nextWorkTab, workTabOf, workTabsFor, initialSessionWorkState } from '../src/renderer/state/session-work-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { TaskDetail, TaskRow } from '../src/domain/tasks/model';

const TASK = 'task-1';

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: TASK, context: 'work', title: 'Fix the export crash on long rowing sessions', summary: null,
  status: 'In progress', deadline: null, dueLabel: null, today: true, effort: null, bucket: null, client: 'Acme',
  topic: null, waitingOn: null, snoozedUntil: null, lastUpdate: null, pullRequests: [], ...over,
});

const detail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  ...row(), notes: null, url: 'https://www.notion.so/task-1', brief: 'Long sessions crash on export.',
  progress: [{ day: '2026-10-28', text: 'Claude started work' }, { day: '2026-10-28', text: 'Found the cause' }],
  ...over,
});

const run = (events: RendererEvent[], state: SessionTaskState = initialSessionTaskState): SessionTaskState =>
  events.reduce(sessionTaskReducer, state);

const on: RendererEvent = { type: 'sessionTasksLoaded', enabled: true, links: { s1: TASK } };

test('a linked session has its task; an unlinked one has none', () => {
  /* When */
  const state = run([on]);

  /* Then */
  assert.equal(taskIdOf(state, 's1'), TASK);
  assert.equal(taskIdOf(state, 's2'), null);
  assert.equal(sessionTaskOf(state, 's2'), null);
});

test('while BlaakTasks is off no session has a task, whatever main said before', () => {
  /* Given */
  const state = run([on]);

  /* When */
  const off = run([{ type: 'sessionTasksLoaded', enabled: false, links: { s1: TASK } }], state);

  /* Then */
  assert.equal(off.enabled, false);
  assert.equal(taskIdOf(off, 's1'), null);
});

test('a link pushed by main shows at once, and an unlink takes it away', () => {
  /* Given */
  const state = run([{ type: 'sessionTasksLoaded', enabled: true, links: {} }]);

  /* When */
  const linked = run([{ type: 'sessionTaskChanged', sessionId: 's2', taskId: 'task-2' }], state);
  const unlinked = run([{ type: 'sessionTaskChanged', sessionId: 's2', taskId: null }], linked);

  /* Then */
  assert.equal(taskIdOf(linked, 's2'), 'task-2');
  assert.equal(taskIdOf(unlinked, 's2'), null);
});

test('a task\'s detail is loading, then loaded; a failure keeps the last one it had', () => {
  /* Given */
  const loaded = run([
    on,
    { type: 'sessionTaskDetailRequested', taskId: TASK },
    { type: 'sessionTaskDetailLoaded', taskId: TASK, result: { kind: 'ok', value: detail() } },
  ]);

  /* When */
  const failed = run([
    { type: 'sessionTaskDetailRequested', taskId: TASK },
    { type: 'sessionTaskDetailLoaded', taskId: TASK, result: { kind: 'unreachable', reason: 'ECONNREFUSED' } },
  ], loaded);

  /* Then */
  assert.equal(sessionTaskOf(loaded, 's1')?.detail?.title, 'Fix the export crash on long rowing sessions');
  assert.equal(failed.tasks[TASK].phase, 'failed');
  assert.equal(sessionTaskOf(failed, 's1')?.detail?.title, 'Fix the export crash on long rowing sessions');
});

test('a polled task row freshens the task\'s status', () => {
  /* Given */
  const state = run([on, { type: 'sessionTaskDetailLoaded', taskId: TASK, result: { kind: 'ok', value: detail() } }]);

  /* When */
  const next = run([{
    type: 'tasksChanged',
    update: { watchId: 'w', query: { view: 'today' }, state: 'ok', rows: [row({ status: 'Waiting' })], fetchedAt: 1 },
  }], state);

  /* Then */
  assert.equal(next.tasks[TASK].detail?.status, 'Waiting');
  assert.equal(next.tasks[TASK].detail?.brief, 'Long sessions crash on export.', 'the detail keeps its brief');
});

test('Mark done takes one press at a time, and shows Done once it went through', () => {
  /* Given */
  const state = run([on, { type: 'sessionTaskDetailLoaded', taskId: TASK, result: { kind: 'ok', value: detail() } }]);

  /* When */
  const asked = run([{ type: 'sessionTaskActionRequested', taskId: TASK, action: 'done' }], state);
  const again = run([{ type: 'sessionTaskActionRequested', taskId: TASK, action: 'snooze' }], asked);
  const answered = run([{ type: 'sessionTaskActionAnswered', taskId: TASK, action: 'done', error: null }], asked);

  /* Then */
  assert.deepEqual(asked.pending, { taskId: TASK, action: 'done' });
  assert.equal(again, asked, 'a second press waits for the first');
  assert.equal(answered.pending, null);
  assert.equal(answered.tasks[TASK].detail?.status, 'Done');
});

test('a refused change says why and leaves the task as it was', () => {
  /* Given */
  const state = run([
    on,
    { type: 'sessionTaskDetailLoaded', taskId: TASK, result: { kind: 'ok', value: detail() } },
    { type: 'sessionTaskActionRequested', taskId: TASK, action: 'snooze' },
  ]);

  /* When */
  const next = run([{ type: 'sessionTaskActionAnswered', taskId: TASK, action: 'snooze', error: 'No such task' }], state);

  /* Then */
  assert.deepEqual(next.actionError, { taskId: TASK, message: 'No such task' });
  assert.equal(next.tasks[TASK].detail?.status, 'In progress');
});

test('Link task… searches, drops a stale answer, and steps through the results', () => {
  /* Given */
  const opened = run([on, { type: 'sessionTaskPickerOpened', sessionId: 's2' }]);

  /* When */
  const typed = run([
    { type: 'sessionTaskSearchChanged', query: 'export' },
    { type: 'sessionTaskSearchAnswered', query: '', result: { kind: 'ok', value: [row({ id: 'stale' })] } },
    { type: 'sessionTaskSearchAnswered', query: 'export', result: { kind: 'ok', value: [row(), row({ id: 'task-2' })] } },
    { type: 'sessionTaskPickerStepped', step: 1 },
    { type: 'sessionTaskPickerStepped', step: 1 },
  ], opened);

  /* Then */
  assert.equal(opened.picker?.sessionId, 's2');
  assert.deepEqual(typed.picker?.results.map((r) => r.id), [TASK, 'task-2']);
  assert.equal(typed.picker?.cursor, 1, 'the cursor stops at the last result');
});

test('Link task… does not open while BlaakTasks is off', () => {
  /* When */
  const state = run([{ type: 'sessionTaskPickerOpened', sessionId: 's1' }]);

  /* Then */
  assert.equal(state.picker, null);
});

test('the archive offer appears only when the event comes, and goes when answered', () => {
  /* Given */
  const state = run([on]);

  /* When */
  const offered = run([{ type: 'taskMarkDoneOffered', sessionId: 's1', taskId: TASK }], state);
  const closed = run([{ type: 'sessionTaskOfferClosed' }], offered);

  /* Then */
  assert.equal(state.offer, null);
  assert.deepEqual(offered.offer, { sessionId: 's1', taskId: TASK });
  assert.equal(closed.offer, null);
});

test('the offer names the task', () => {
  /* Then */
  assert.equal(offerQuestion(detail()), 'Mark “Fix the export crash on long rowing sessions” done?');
  assert.equal(offerQuestion(detail({ summary: 'Export crash' })), 'Mark “Export crash” done?');
  assert.equal(offerQuestion(null), 'Mark its task done?');
});

test('a re-keyed session keeps its task and its offer', () => {
  /* Given */
  const state = run([on, { type: 'taskMarkDoneOffered', sessionId: 's1', taskId: TASK }]);

  /* When */
  const moved = rekeySessionTask(state, 's1', 's1b');

  /* Then */
  assert.equal(taskIdOf(moved, 's1b'), TASK);
  assert.equal(taskIdOf(moved, 's1'), null);
  assert.equal(moved.offer?.sessionId, 's1b');
});

test('the root reducer carries the slice, and a fork moves it', () => {
  /* Given */
  const state = rootReducer(initialRendererState(), on);

  /* When */
  const forked = rootReducer(state, { type: 'sessionForked', oldId: 's1', newId: 's9' });

  /* Then */
  assert.equal(taskIdOf(state.sessionTask, 's1'), TASK);
  assert.equal(taskIdOf(forked.sessionTask, 's9'), TASK);
});

test('the Task tab is there only while the session works on a task', () => {
  /* Given */
  const sessionWork = { ...initialSessionWorkState, tabs: { s1: 'task' as const } };

  /* Then */
  assert.equal(workTabOf(sessionWork, 's1', true), 'task');
  assert.equal(workTabOf(sessionWork, 's1', false), 'work', 'unlinked, the page is back on Work');
  assert.deepEqual(workTabsFor(false), ['work', 'plan']);
  assert.equal(nextWorkTab('plan', workTabsFor(true)), 'task');
  assert.equal(nextWorkTab('task', workTabsFor(true)), 'work');
  assert.equal(nextWorkTab('plan', workTabsFor(false)), 'work');
});

test('the task\'s PRs show the state the session knows them in', () => {
  /* Given */
  const urls = [
    'https://github.com/acme/rowing-app/pull/412',
    'https://github.com/acme/rowing-app/pull/415',
    'https://github.com/acme/rowing-app/pull/420',
    'https://github.com/acme/other/pull/7',
  ];
  const known = [
    { url: urls[0], number: 412, repository: 'acme/rowing-app', state: 'merged' as const },
    { url: 'https://github.com/acme/rowing-app/pull/415', number: 415, repository: 'acme/rowing-app', state: 'open' as const },
  ];

  /* When */
  const pills = taskPullRequestPills(urls, known, (number) => (number === 420 ? 'amber' : null));

  /* Then */
  assert.deepEqual(pills.map((p) => [p.label, p.tone]), [
    ['#412 merged', 'lavender'],
    ['#415 open', 'blue'],
    ['#420', 'amber'],
    ['#7', 'grey'],
  ]);
});

test('Snooze snoozes until tomorrow, across a month\'s end', () => {
  /* Then */
  assert.equal(tomorrow(new Date(2026, 9, 31, 23, 30)), '2026-11-01');
});

test('the lines Switchboard wrote are told apart from Claude\'s', () => {
  /* Then */
  assert.equal(writtenBySwitchboard('Opened PR #412'), true);
  assert.equal(writtenBySwitchboard('Session archived'), true);
  assert.equal(writtenBySwitchboard('Claude started work'), true);
  assert.equal(writtenBySwitchboard('CI green on #412'), false);
});

test('statuses take their pill tone', () => {
  /* Then */
  assert.deepEqual(['In progress', 'Waiting', 'Done', 'Not started'].map((s) => statusTone(s as TaskRow['status'])),
    ['blue', 'amber', 'green', 'grey']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answerOfferWith, archiveAnswerEvents, markDoneWith } from '../src/renderer/ui/session-task/offer';
import type { OfferSteps } from '../src/renderer/ui/session-task/offer';
import { initialSessionTaskState, sessionTaskReducer } from '../src/renderer/state/session-task-slice';
import type { RendererEvent } from '../src/renderer/state/events';
import type { TaskChange, TaskUpdateResult } from '../src/domain/tasks/surface';

/** Steps that record what was dispatched and sent, answering updates with `answer`. */
function fakeSteps(answer: TaskUpdateResult | Error = { kind: 'ok', value: null }) {
  const events: RendererEvent[] = [];
  const updates: [string, TaskChange][] = [];
  const refreshed: string[] = [];
  const steps: OfferSteps = {
    dispatch: (event) => events.push(event),
    updateTask: async (taskId, change) => {
      updates.push([taskId, change]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    refresh: (taskId) => refreshed.push(taskId),
  };
  return { steps, events, updates, refreshed };
}

const offer = { sessionId: 's1', taskId: 'task-1' };

test('an archive main answers with Mark done brings the offer', () => {
  /* When */
  const events = archiveAnswerEvents('s1', { markDone: { taskId: 'task-1' } });

  /* Then */
  assert.deepEqual(events, [{ type: 'taskMarkDoneOffered', sessionId: 's1', taskId: 'task-1' }]);
});

test('any other archive brings nothing', () => {
  /* Then */
  assert.deepEqual(archiveAnswerEvents('s1', {}), []);
  assert.deepEqual(archiveAnswerEvents('s1', null), []);
});

test('D on the offer marks the task done and puts the offer away', async () => {
  /* Given */
  const { steps, events, updates, refreshed } = fakeSteps();

  /* When */
  await answerOfferWith(steps, offer, 'done');

  /* Then */
  assert.deepEqual(updates, [['task-1', { kind: 'done' }]]);
  assert.deepEqual(events.map((e) => e.type), ['sessionTaskOfferClosed', 'sessionTaskActionRequested', 'sessionTaskActionAnswered']);
  assert.deepEqual(refreshed, ['task-1']);
});

test('Leave it marks nothing', async () => {
  /* Given */
  const { steps, events, updates } = fakeSteps();

  /* When */
  await answerOfferWith(steps, offer, 'leave');

  /* Then */
  assert.deepEqual(updates, []);
  assert.deepEqual(events, [{ type: 'sessionTaskOfferClosed' }]);
});

test('the whole archive, through the slice: offered, then D, then gone and Done asked', async () => {
  /* Given */
  const { steps, events, updates } = fakeSteps({ kind: 'queued' });
  let state = sessionTaskReducer(initialSessionTaskState, { type: 'sessionTasksLoaded', enabled: true, links: { s1: 'task-1' } });
  for (const event of archiveAnswerEvents('s1', { markDone: { taskId: 'task-1' } })) state = sessionTaskReducer(state, event);
  assert.deepEqual(state.offer, offer);

  /* When */
  await answerOfferWith(steps, state.offer!, 'done');
  for (const event of events) state = sessionTaskReducer(state, event);

  /* Then */
  assert.equal(state.offer, null);
  assert.equal(state.pending, null);
  assert.equal(state.actionError, null, 'a Done queued for the next poll is not an error');
  assert.deepEqual(updates, [['task-1', { kind: 'done' }]]);
});

test('Mark done that BlaakTasks refuses says why, and asks for nothing again', async () => {
  /* Given */
  const { steps, events, refreshed } = fakeSteps({ kind: 'failed', reason: 'Not a task id: task-1' });

  /* When */
  await markDoneWith(steps, 'task-1');

  /* Then */
  assert.deepEqual(events.at(-1), { type: 'sessionTaskActionAnswered', taskId: 'task-1', action: 'done', error: 'Not a task id: task-1' });
  assert.deepEqual(refreshed, []);
});

test('Mark done that throws is an answer too', async () => {
  /* Given */
  const { steps, events } = fakeSteps(new Error('IPC gone'));

  /* When */
  await markDoneWith(steps, 'task-1');

  /* Then */
  assert.deepEqual(events.at(-1), { type: 'sessionTaskActionAnswered', taskId: 'task-1', action: 'done', error: 'IPC gone' });
});

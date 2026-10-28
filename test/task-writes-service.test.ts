import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_REFUSED_ATTEMPTS, TaskWritesService } from '../src/application/services/task-writes-service';
import { silentLog } from './support/fakes';
import type { BlaakTasks } from '../src/application/ports/blaak-tasks';
import type { BlaakTasksResult, TaskDetail, TaskPatch, TaskRow } from '../src/domain/tasks/model';
import type { SessionPullRequest } from '../src/domain/session/session';
import type { PullRequestState } from '../src/domain/tasks/writes';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const pr = (n: number): SessionPullRequest => ({ number: n, url: `https://github.com/o/app/pull/${n}`, repository: 'o/app' });

type Call =
  | ['update', string, TaskPatch]
  | ['progress', string, string, string | undefined];

const ROW = { id: TASK } as TaskRow;

/** BlaakTasks, recording every write and answering what the test says it should. */
class FakeBlaakTasks implements Pick<BlaakTasks, 'get' | 'update' | 'progress'> {
  calls: Call[] = [];
  /** The ids `get` was asked for. */
  reads: string[] = [];
  /** The PRs the task carries already, as `get` answers them. */
  carried: string[] = [];
  /** The answer every call gets, until the test changes it. */
  answer: BlaakTasksResult<TaskRow> = { kind: 'ok', value: ROW };
  /** `get`'s answer when it differs from every other call's. */
  getAnswer: BlaakTasksResult<TaskDetail> | null = null;
  async get(id: string): Promise<BlaakTasksResult<TaskDetail>> {
    this.reads.push(id);
    if (this.getAnswer) return this.getAnswer;
    if (this.answer.kind !== 'ok') return this.answer;
    return { kind: 'ok', value: { ...ROW, pullRequests: [...this.carried] } as TaskDetail };
  }
  async update(id: string, patch: TaskPatch) {
    this.calls.push(['update', id, patch]);
    return this.answer;
  }
  async progress(id: string, text: string, pullRequest?: string) {
    this.calls.push(['progress', id, text, pullRequest]);
    return this.answer;
  }
}

function setup({
  links = { s1: TASK } as Record<string, string>,
  pullRequests = {} as Record<string, SessionPullRequest[]>,
  states = {} as Record<string, PullRequestState>,
} = {}) {
  const tasks = new FakeBlaakTasks();
  const service = new TaskWritesService({
    tasks,
    links: { taskOf: (sessionId) => links[sessionId] ?? null },
    pullRequests: (sessionId) => pullRequests[sessionId] ?? [],
    pullRequestState: (url) => states[url] ?? null,
    log: silentLog,
  });
  return { tasks, service };
}

test('a task session starting sets its task In progress and stars it for today', async () => {
  /* Given */
  const { tasks, service } = setup();

  /* When */
  const outcome = await service.sessionStarted('s1');

  /* Then */
  assert.equal(outcome, 'sent');
  assert.deepEqual(tasks.calls, [['update', TASK, { status: 'In progress', today: true }]]);
});

test('a session without a task writes nothing, whatever happens to it', async () => {
  /* Given */
  const { tasks, service } = setup({ pullRequests: { s9: [pr(7)] }, states: { [pr(7).url]: 'merged' } });

  /* When */
  const started = await service.sessionStarted('s9');
  const opened = await service.pullRequestOpened('s9', pr(7));
  const offer = await service.sessionArchived('s9', { byUser: true });
  await service.retry();

  /* Then */
  assert.equal(started, 'skipped');
  assert.equal(opened, 'skipped');
  assert.equal(offer, false);
  assert.deepEqual(tasks.calls, []);
});

test('each PR the session opens goes on its task once, with an Opened PR line', async () => {
  /* Given */
  const { tasks, service } = setup();

  /* When */
  await service.pullRequestOpened('s1', pr(7));
  const again = await service.pullRequestOpened('s1', pr(7));
  await service.pullRequestOpened('s1', pr(8));

  /* Then */
  assert.equal(again, 'skipped');
  assert.deepEqual(tasks.calls, [
    ['progress', TASK, 'Opened PR #7', pr(7).url],
    ['progress', TASK, 'Opened PR #8', pr(8).url],
  ]);
});

test('archiving a task session logs it and, archived by you with every PR merged, offers Mark done', async () => {
  /* Given */
  const { tasks, service } = setup({
    pullRequests: { s1: [pr(7), pr(8)] },
    states: { [pr(7).url]: 'merged', [pr(8).url]: 'merged' },
  });

  /* When */
  const offer = await service.sessionArchived('s1', { byUser: true });
  await service.retry();

  /* Then */
  assert.equal(offer, true);
  assert.deepEqual(tasks.calls, [['progress', TASK, 'Session archived', undefined]]);
});

test('archiving offers nothing when a PR was closed without merging, is still open, or the session archived itself', async () => {
  /* Given */
  const closed = setup({ pullRequests: { s1: [pr(7), pr(8)] }, states: { [pr(7).url]: 'merged', [pr(8).url]: 'closed' } });
  const open = setup({ pullRequests: { s1: [pr(7)] }, states: { [pr(7).url]: 'open' } });
  const itself = setup({ pullRequests: { s1: [pr(7)] }, states: { [pr(7).url]: 'merged' } });

  /* When */
  const offers = [
    await closed.service.sessionArchived('s1', { byUser: true }),
    await open.service.sessionArchived('s1', { byUser: true }),
    await itself.service.sessionArchived('s1', { byUser: false }),
  ];
  await itself.service.retry();

  /* Then */
  assert.deepEqual(offers, [false, false, false]);
  assert.deepEqual(itself.tasks.calls, [['progress', TASK, 'Session archived', undefined]]);
});

test('Mark done sets the task Done, and is the only write that does', async () => {
  /* Given */
  const { tasks, service } = setup({ pullRequests: { s1: [pr(7)] }, states: { [pr(7).url]: 'merged' } });
  await service.sessionStarted('s1');
  await service.pullRequestOpened('s1', pr(7));
  await service.sessionArchived('s1', { byUser: true });
  await service.retry();
  const beforeDone = tasks.calls.filter((call) => call[0] === 'update' && call[2].status === 'Done');

  /* When */
  const outcome = await service.markDone(OTHER.replace(/-/g, '').toUpperCase());

  /* Then */
  assert.equal(outcome, 'sent');
  assert.deepEqual(beforeDone, []);
  assert.deepEqual(tasks.calls.at(-1), ['update', OTHER, { status: 'Done' }]);
});

test('Mark done on something that is not a task id writes nothing', async () => {
  /* Given */
  const { tasks, service } = setup();

  /* When */
  const outcome = await service.markDone('not-a-task');

  /* Then */
  assert.equal(outcome, 'skipped');
  assert.deepEqual(tasks.calls, []);
});

test('a write BlaakTasks cannot be reached for is queued, and retry sends it once it is back', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.answer = { kind: 'unreachable', reason: 'ECONNREFUSED' };
  const outcome = await service.sessionStarted('s1');
  await service.retry();
  tasks.answer = { kind: 'ok', value: ROW };
  tasks.calls = [];

  /* When */
  await service.retry();
  await service.retry();

  /* Then */
  assert.equal(outcome, 'queued');
  assert.deepEqual(tasks.calls, [['update', TASK, { status: 'In progress', today: true }]]);
  assert.deepEqual(service.pending(), []);
});

test('queued writes are sent in the order they happened, and a newer one never overtakes them', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.answer = { kind: 'unreachable', reason: 'timeout' };
  await service.sessionStarted('s1');
  tasks.answer = { kind: 'ok', value: ROW };
  tasks.calls = [];

  /* When */
  await service.pullRequestOpened('s1', pr(7));
  const calls = tasks.calls;

  /* Then */
  assert.deepEqual(calls, [
    ['update', TASK, { status: 'In progress', today: true }],
    ['progress', TASK, 'Opened PR #7', pr(7).url],
  ]);
});

test('while BlaakTasks is down, later writes wait behind the first instead of being tried', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.answer = { kind: 'unreachable', reason: 'timeout' };

  /* When */
  await service.sessionStarted('s1');
  const opened = await service.pullRequestOpened('s1', pr(7));
  const done = await service.markDone(TASK);

  /* Then */
  assert.deepEqual([opened, done], ['queued', 'queued']);
  // Each new write tries the one at the head again, and nothing behind it.
  const inProgress = ['update', TASK, { status: 'In progress', today: true }];
  assert.deepEqual(tasks.calls, [inProgress, inProgress, inProgress]);
  assert.deepEqual(service.pending().map((write) => write.kind), ['update', 'progress', 'update']);
});

test('a write BlaakTasks keeps refusing is given up on, and the ones behind it go through', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.update = async (id, patch) => {
    tasks.calls.push(['update', id, patch]);
    return { kind: 'failed', reason: 'unknown id' };
  };
  const started = await service.sessionStarted('s1');
  const opened = await service.pullRequestOpened('s1', pr(7));

  /* When */
  for (let attempt = 3; attempt <= MAX_REFUSED_ATTEMPTS; attempt++) await service.retry();
  await service.retry();

  /* Then */
  assert.deepEqual([started, opened], ['queued', 'queued']);
  assert.deepEqual(tasks.calls.map((call) => call[0]), [
    ...Array(MAX_REFUSED_ATTEMPTS).fill('update'), 'progress',
  ]);
  assert.deepEqual(service.pending(), []);
});

test('with BlaakTasks off or not set up, nothing is queued to catch up on later', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.answer = { kind: 'off' };
  const off = await service.sessionStarted('s1');
  tasks.answer = { kind: 'notSetUp' };
  const notSetUp = await service.pullRequestOpened('s1', pr(7));
  tasks.answer = { kind: 'ok', value: ROW };
  tasks.calls = [];

  /* When */
  await service.retry();

  /* Then */
  assert.deepEqual([off, notSetUp], ['dropped', 'dropped']);
  assert.deepEqual(tasks.calls, []);
});

test('a port that throws after all is an outage, not a crash', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.update = async () => { throw new Error('boom'); };

  /* When */
  const outcome = await service.sessionStarted('s1');

  /* Then */
  assert.equal(outcome, 'queued');
  assert.equal(service.pending().length, 1);
});

test('a PR the task already carries is not written again, as after a restart replaying its pr-links', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.carried = [pr(7).url];

  /* When */
  const known = await service.pullRequestOpened('s1', pr(7));
  const fresh = await service.pullRequestOpened('s1', pr(8));

  /* Then */
  assert.deepEqual([known, fresh], ['skipped', 'sent']);
  assert.deepEqual(tasks.reads, [TASK, TASK]);
  assert.deepEqual(tasks.calls, [['progress', TASK, 'Opened PR #8', pr(8).url]]);
});

test('a PR line whose task cannot be read is queued, and checked again when retried', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.getAnswer = { kind: 'unreachable', reason: 'timeout' };
  const outcome = await service.pullRequestOpened('s1', pr(7));
  tasks.getAnswer = null;
  // Meanwhile the PR reached the task some other way.
  tasks.carried = [pr(7).url];

  /* When */
  await service.retry();

  /* Then */
  assert.equal(outcome, 'queued');
  assert.deepEqual(tasks.reads, [TASK, TASK]);
  assert.deepEqual(tasks.calls, []);
  assert.deepEqual(service.pending(), []);
});

test('a queued PR line the task does not carry yet is written once BlaakTasks is back', async () => {
  /* Given */
  const { tasks, service } = setup();
  tasks.getAnswer = { kind: 'unreachable', reason: 'timeout' };
  await service.pullRequestOpened('s1', pr(7));
  tasks.getAnswer = null;

  /* When */
  await service.retry();

  /* Then */
  assert.deepEqual(tasks.calls, [['progress', TASK, 'Opened PR #7', pr(7).url]]);
  assert.deepEqual(service.pending(), []);
});

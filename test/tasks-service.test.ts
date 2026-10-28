import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TASKS_POLL_MS, TasksService, type TaskServices } from '../src/application/services/tasks-service';
import { TaskLinkService } from '../src/application/services/task-link-service';
import { TaskWritesService } from '../src/application/services/task-writes-service';
import { MemoryTaskLinkStore, fakeRenderer, fakeTimers, silentLog } from './support/fakes';
import type { BlaakTasks } from '../src/application/ports/blaak-tasks';
import type { BlaakTasksResult, TaskDetail, TaskPatch, TaskRow, TaskView } from '../src/domain/tasks/model';
import type { SessionPullRequest } from '../src/domain/session/session';
import type { TaskSessionPreparation } from '../src/domain/tasks/start';
import type { PullRequestState } from '../src/domain/tasks/writes';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const URL = 'https://tasks.example.com/mcp';
const row = (id: string, title = 'Fix the login'): TaskRow => ({ id, title } as TaskRow);
const pr = (n: number): SessionPullRequest => ({ number: n, url: `https://github.com/o/app/pull/${n}`, repository: 'o/app' });

/** BlaakTasks, recording every call and answering what the test says. */
class FakeBlaakTasks implements BlaakTasks {
  calls: string[] = [];
  rows: TaskRow[] = [row(TASK)];
  answer: BlaakTasksResult<never> | null = null;
  async list(view: TaskView): Promise<BlaakTasksResult<TaskRow[]>> {
    this.calls.push('list ' + view);
    return this.answer ?? { kind: 'ok', value: this.rows };
  }
  async get(id: string): Promise<BlaakTasksResult<TaskDetail>> {
    this.calls.push('get ' + id);
    return this.answer ?? { kind: 'ok', value: { ...row(id), pullRequests: [] } as unknown as TaskDetail };
  }
  async update(id: string, patch: TaskPatch): Promise<BlaakTasksResult<TaskRow>> {
    this.calls.push(`update ${id} ${JSON.stringify(patch)}`);
    return this.answer ?? { kind: 'ok', value: row(id) };
  }
  async progress(id: string, text: string, pullRequest?: string): Promise<BlaakTasksResult<TaskRow>> {
    this.calls.push(`progress ${id} ${text}` + (pullRequest ? ' ' + pullRequest : ''));
    return this.answer ?? { kind: 'ok', value: row(id) };
  }
}

/** Let the background writes and fetches settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({
  url = URL,
  running = [] as { sessionId: string; projectPath: string; folder: string }[],
  transcripts = {} as Record<string, string[]>,
  pullRequests = {} as Record<string, SessionPullRequest[]>,
  states = {} as Record<string, PullRequestState>,
  archived = [] as string[],
} = {}) {
  const settings = { url };
  const blaakTasks = new FakeBlaakTasks();
  const store = new MemoryTaskLinkStore();
  const renderer = fakeRenderer();
  const timers = fakeTimers();
  const clock = { at: 1_000, now() { return this.at; } };
  const prepared: string[] = [];
  const builds: string[] = [];
  const build = (builtFor: string): TaskServices => {
    builds.push(builtFor);
    const links = new TaskLinkService({ store, sessions: () => [], clock });
    const writes = new TaskWritesService({
      tasks: blaakTasks,
      links,
      pullRequests: (sessionId) => pullRequests[sessionId] ?? [],
      pullRequestState: (prUrl) => states[prUrl] ?? null,
      log: silentLog,
    });
    const starts = {
      prepare: async (task: { id: string }, options: { projectPath?: string }): Promise<TaskSessionPreparation> => {
        prepared.push(task.id + ' in ' + (options.projectPath ?? 'its repo'));
        return { kind: 'ready', projectPath: '/code/app', worktreePath: '/code/app/.claude/worktrees/fix-the-login', branch: 'fix-the-login', prompt: 'Work on my task' };
      },
    };
    return { tasks: blaakTasks, links, starts, writes };
  };
  const service = new TasksService({
    url: () => settings.url,
    build,
    renderer,
    sessionsIn: (folder) => running.filter((session) => session.folder === folder),
    transcript: (_folder, sessionId) => transcripts[sessionId] ?? [],
    modifiedAt: (_folder, sessionId) => (transcripts[sessionId] ? transcripts[sessionId].length : null),
    pullRequests: (sessionId) => pullRequests[sessionId] ?? [],
    archived: (sessionId) => archived.includes(sessionId),
    sessionProject: (sessionId) => (sessionId === 's1' ? '/code/app/.claude/worktrees/x' : null),
    repoRoot: async (projectPath) => projectPath.replace(/\/\.claude\/worktrees\/.*$/, ''),
    clock, timers, log: silentLog,
  });
  return { service, settings, blaakTasks, store, renderer, timers, clock, builds, prepared };
}

function updateCall(task: string): string {
  return `update ${task} {"status":"In progress","today":true}`;
}

function linkingCall(taskId: string, timestamp = '2026-10-20T10:00:00.000Z'): string {
  return JSON.stringify({
    type: 'assistant', timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'mcp__blaaktasks__progress', input: { id: taskId, text: 'Started' } }] },
  });
}

// ── The switch ──

test('with no URL set there are no task services, and nothing reaches BlaakTasks', async () => {
  /* Given */
  const { service, blaakTasks, builds } = setup({ url: '' });

  /* When */
  const listed = await service.list({ view: 'today' });
  const got = await service.get(TASK);
  const updated = await service.update(TASK, { kind: 'done' });
  const prepared = await service.prepareStart({ task: { id: TASK, title: 'Fix the login' } });
  const offer = await service.archived('s1', { byUser: true });

  /* Then */
  assert.deepEqual([listed, got, updated, prepared], [{ kind: 'off' }, { kind: 'off' }, { kind: 'off' }, { kind: 'off' }]);
  assert.equal(offer, null);
  assert.deepEqual(service.sessionTasks(), {});
  assert.equal(service.services(), null);
  assert.deepEqual(builds, []);
  assert.deepEqual(blaakTasks.calls, []);
});

test('the services are built once for a URL, again when it changes, and dropped when it is cleared', () => {
  /* Given */
  const { service, settings, builds } = setup();

  /* When */
  service.services();
  service.services();
  settings.url = 'https://tasks.example.com/other';
  service.services();
  settings.url = '';
  const off = service.services();

  /* Then */
  assert.deepEqual(builds, [URL, 'https://tasks.example.com/other']);
  assert.equal(off, null);
});

test('building the services writes the PRs of linked sessions that are not archived', async () => {
  /* Given */
  const { service, store, blaakTasks } = setup({ pullRequests: { s1: [pr(7)], s2: [pr(8)] }, archived: ['s2'] });
  store.link({ taskId: TASK, sessionId: 's1', projectPath: '/code/app', source: 'start', linkedAt: 1 });
  store.link({ taskId: TASK, sessionId: 's2', projectPath: '/code/app', source: 'start', linkedAt: 1 });

  /* When */
  service.start();
  await settle();

  /* Then */
  assert.deepEqual(blaakTasks.calls, ['get ' + TASK, `progress ${TASK} Opened PR #7 ${pr(7).url}`]);
});

// ── Starting from a task ──

test('preparing a start passes the project and the existing-branch choice on', async () => {
  /* Given */
  const { service, prepared } = setup();

  /* When */
  const answer = await service.prepareStart({ task: { id: TASK, title: 'Fix the login' }, projectPath: '/code/app', existing: 'reuse' });

  /* Then */
  assert.equal(answer.kind, 'ready');
  assert.deepEqual(prepared, [TASK + ' in /code/app']);
});

test('a started task session is linked, the renderer told, and the task set In progress', async () => {
  /* Given */
  const { service, blaakTasks, renderer } = setup();

  /* When */
  service.sessionStarted(TASK, 's1', '/code/app');
  await settle();

  /* Then */
  assert.equal(service.sessionTask('s1'), TASK);
  assert.deepEqual(service.taskSessions(TASK), { sessions: ['s1'], owner: 's1' });
  assert.deepEqual(service.projectTasks('/code/app'), [TASK]);
  assert.deepEqual(renderer.only('sessionTaskChanged'), [['sessionTaskChanged', 's1', TASK]]);
  assert.deepEqual(blaakTasks.calls, [updateCall(TASK)]);
});

// ── Links by hand ──

test('linking by hand links in the session\'s repository, and unlinking tells the renderer', async () => {
  /* Given */
  const { service, store, renderer } = setup();

  /* When */
  await service.link('s1', TASK);

  /* Then */
  assert.equal(store.forSession('s1')?.projectPath, '/code/app');
  assert.equal(store.forSession('s1')?.source, 'manual');
  assert.deepEqual(service.sessionTasks(), { s1: TASK });

  /* When */
  service.unlink('s1');

  /* Then */
  assert.equal(service.sessionTask('s1'), null);
  assert.deepEqual(renderer.only('sessionTaskChanged'), [['sessionTaskChanged', 's1', TASK], ['sessionTaskChanged', 's1', null]]);
});

test('linking a session that does not exist is refused', async () => {
  /* Given */
  const { service } = setup();

  /* When */
  const linking = service.link('nope', TASK);

  /* Then */
  await assert.rejects(linking, /No such session/);
});

// ── Transcripts ──

test('a transcript naming a task links its session in its repository, and its PRs go on the task', async () => {
  /* Given */
  const { service, store, renderer, blaakTasks } = setup({
    running: [{ sessionId: 's1', projectPath: '/code/app/.claude/worktrees/x', folder: 'f' }],
    transcripts: { s1: [linkingCall(TASK)] },
    pullRequests: { s1: [pr(9)] },
  });

  /* When */
  await service.transcriptsChanged('f');
  await settle();

  /* Then */
  assert.equal(store.forSession('s1')?.source, 'detected');
  assert.equal(store.forSession('s1')?.projectPath, '/code/app');
  assert.deepEqual(renderer.only('sessionTaskChanged'), [['sessionTaskChanged', 's1', TASK]]);
  assert.deepEqual(blaakTasks.calls, ['get ' + TASK, `progress ${TASK} Opened PR #9 ${pr(9).url}`]);
});

test('a transcript not written since it was last read is not read again', async () => {
  /* Given */
  const { service, renderer } = setup({
    running: [{ sessionId: 's1', projectPath: '/code/app', folder: 'f' }],
    transcripts: { s1: [linkingCall(TASK)] },
  });
  await service.transcriptsChanged('f');
  service.unlink('s1');

  /* When */
  await service.transcriptsChanged('f');

  /* Then */
  assert.equal(service.sessionTask('s1'), null);
  assert.equal(renderer.only('sessionTaskChanged').length, 2);
});

test('a session without a task writes none of its PRs', async () => {
  /* Given */
  const { service, blaakTasks } = setup({
    running: [{ sessionId: 's1', projectPath: '/code/app', folder: 'f' }],
    transcripts: { s1: ['{}'] },
    pullRequests: { s1: [pr(9)] },
  });

  /* When */
  await service.transcriptsChanged('f');
  await settle();

  /* Then */
  assert.deepEqual(blaakTasks.calls, []);
});

// ── Archiving ──

test('archiving a task session by hand with every PR merged offers Mark done, and writes the line', async () => {
  /* Given */
  const { service, blaakTasks } = setup({ pullRequests: { s1: [pr(7)] }, states: { [pr(7).url]: 'merged' } });
  service.sessionStarted(TASK, 's1', '/code/app');
  await settle();
  blaakTasks.calls = [];

  /* When */
  const offer = await service.archived('s1', { byUser: true });
  await settle();

  /* Then */
  assert.deepEqual(offer, { taskId: TASK });
  assert.deepEqual(blaakTasks.calls, [`progress ${TASK} Session archived`]);
});

test('a session archiving itself offers nothing, though its PRs are merged', async () => {
  /* Given */
  const { service } = setup({ pullRequests: { s1: [pr(7)] }, states: { [pr(7).url]: 'merged' } });
  service.sessionStarted(TASK, 's1', '/code/app');

  /* When */
  const offer = await service.archived('s1', { byUser: false });

  /* Then */
  assert.equal(offer, null);
});

// ── Changing a task ──

test('★ and snooze are sent as updates, and Done goes through the writes queue', async () => {
  /* Given */
  const { service, blaakTasks } = setup();

  /* When */
  const starred = await service.update(TASK, { kind: 'star', today: true });
  const snoozed = await service.update(TASK, { kind: 'snooze', until: '2026-10-29' });
  const done = await service.update(TASK, { kind: 'done' });

  /* Then */
  assert.deepEqual(starred, { kind: 'ok', value: row(TASK) });
  assert.equal(snoozed.kind, 'ok');
  assert.deepEqual(done, { kind: 'ok', value: null });
  assert.deepEqual(blaakTasks.calls, [
    `update ${TASK} {"today":true}`,
    `update ${TASK} {"snoozedUntil":"2026-10-29"}`,
    `update ${TASK} {"status":"Done"}`,
  ]);
});

test('Done that does not get through is queued, and sent on the next poll', async () => {
  /* Given */
  const { service, blaakTasks } = setup();
  blaakTasks.answer = { kind: 'unreachable', reason: 'timed out' } as never;

  /* When */
  const done = await service.update(TASK, { kind: 'done' });

  /* Then */
  assert.deepEqual(done, { kind: 'queued' });

  /* When */
  blaakTasks.answer = null;
  blaakTasks.calls = [];
  await service.poll();

  /* Then */
  assert.deepEqual(blaakTasks.calls, [`update ${TASK} {"status":"Done"}`]);
});

// ── The poll ──

test('watching a list asks it at once and pushes it, and the poll runs only while something watches', async () => {
  /* Given */
  const { service, renderer, timers, blaakTasks } = setup();

  /* When */
  service.watch('page', { view: 'today' });
  await settle();

  /* Then */
  assert.equal(service.polling, true);
  assert.equal(timers.pending, 1);
  assert.deepEqual(blaakTasks.calls, ['list today']);
  assert.deepEqual(renderer.only('tasksChanged'), [['tasksChanged', {
    watchId: 'page', query: { view: 'today' }, state: 'ok', rows: [row(TASK)], fetchedAt: 1_000,
  }]]);

  /* When */
  service.unwatch('page');

  /* Then */
  assert.equal(service.polling, false);
  assert.equal(timers.pending, 0);
});

test('a poll BlaakTasks does not answer keeps the last rows and says it is unreachable', async () => {
  /* Given */
  const { service, renderer, blaakTasks } = setup();
  service.watch('page', { view: 'due' });
  await settle();
  blaakTasks.answer = { kind: 'unreachable', reason: 'timed out' } as never;

  /* When */
  await service.poll();

  /* Then */
  const pushed = renderer.only('tasksChanged').map(([, update]) => update);
  assert.deepEqual(pushed.at(-1), {
    watchId: 'page', query: { view: 'due' }, state: 'unreachable', rows: [row(TASK)], reason: 'timed out', fetchedAt: 1_000,
  });
});

test('every poll first sends the writes that did not get through', async () => {
  /* Given */
  const { service, blaakTasks } = setup();
  blaakTasks.answer = { kind: 'unreachable', reason: 'down' } as never;
  service.sessionStarted(TASK, 's1', '/code/app');
  await settle();
  blaakTasks.answer = null;
  blaakTasks.calls = [];
  service.watch('page', null);

  /* When */
  await service.poll();

  /* Then */
  assert.deepEqual(blaakTasks.calls, [updateCall(TASK)]);
});

test('the poll timer asks every watched list again, a minute apart', async () => {
  /* Given */
  const { service, timers, blaakTasks } = setup();
  service.watch('page', { view: 'today' });
  service.watch('project', { view: 'quick', options: { context: 'work' } });
  await settle();
  blaakTasks.calls = [];

  /* When */
  timers.tick();
  await settle();
  await settle();

  /* Then */
  assert.equal(TASKS_POLL_MS, 60_000);
  assert.deepEqual(blaakTasks.calls.sort(), ['list quick', 'list today']);
});

test('with the URL cleared, a watched list is pushed as off without calling BlaakTasks', async () => {
  /* Given */
  const { service, settings, renderer, blaakTasks } = setup();
  service.watch('page', { view: 'today' });
  await settle();
  settings.url = '';
  blaakTasks.calls = [];

  /* When */
  await service.poll();

  /* Then */
  const pushed = renderer.only('tasksChanged').map(([, update]) => update);
  assert.deepEqual(pushed.at(-1), { watchId: 'page', query: { view: 'today' }, state: 'off', rows: [], fetchedAt: null });
  assert.deepEqual(blaakTasks.calls, []);
});

test('closing the window drops every watch, and the poll stops', () => {
  /* Given */
  const { service } = setup();
  service.watch('page', { view: 'today' });
  service.watch('tab', null);

  /* When */
  service.unwatchAll();

  /* Then */
  assert.equal(service.polling, false);
});

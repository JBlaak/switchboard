import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TaskLinkService, type TaskLinkSession } from '../src/application/services/task-link-service';
import type { SessionTaskLink, TaskLinkStore } from '../src/application/ports/task-link-store';
import type { TaskLink } from '../src/domain/tasks/links';

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** The store as the SQLite one behaves: one link per session, one repo set by hand per task. */
class MemoryTaskLinkStore implements TaskLinkStore {
  links: TaskLink[] = [];
  unlinks = new Map<string, number>();
  all(): TaskLink[] { return [...this.links]; }
  forTask(taskId: string): TaskLink[] { return this.links.filter((link) => link.taskId === taskId); }
  forSession(sessionId: string): TaskLink | null { return this.links.find((link) => link.sessionId === sessionId) ?? null; }
  link(link: SessionTaskLink): void {
    this.links = this.links.filter((other) => other.sessionId !== link.sessionId);
    this.links.push({ ...link });
    this.unlinks.delete(link.sessionId);
  }
  unlink(sessionId: string, at: number): void {
    this.links = this.links.filter((link) => link.sessionId !== sessionId);
    this.unlinks.set(sessionId, at);
  }
  unlinkedAt(sessionId: string): number | null { return this.unlinks.get(sessionId) ?? null; }
  setRepo(taskId: string, projectPath: string, at: number): void {
    this.links = this.links.filter((link) => !(link.taskId === taskId && link.sessionId === null));
    this.links.push({ taskId, projectPath, sessionId: null, source: 'manual', linkedAt: at });
  }
}

function setup(sessions: TaskLinkSession[] = []) {
  const store = new MemoryTaskLinkStore();
  const clock = { at: 1_000, now() { return this.at; } };
  const service = new TaskLinkService({ store, sessions: () => sessions, clock });
  return { store, clock, service };
}

function toolCall(name: string, id: string, timestamp: string): string {
  return JSON.stringify({
    type: 'assistant', timestamp,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_' + timestamp, name, input: { id } }] },
  });
}

test('linking a session to another task replaces its old link', () => {
  /* Given */
  const { service, clock } = setup();
  service.link(TASK, 's1', '/code/app', 'start');
  clock.at = 2_000;

  /* When */
  service.link(OTHER, 's1', '/code/app', 'manual');

  /* Then */
  assert.equal(service.taskOf('s1'), OTHER);
  assert.deepEqual(service.sessionsOf(TASK), []);
  assert.deepEqual(service.sessionsOf(OTHER), ['s1']);
});

test('a link answers what was stored, with the id in Notion\'s form and the time', () => {
  /* Given */
  const { service, store } = setup();

  /* When */
  const link = service.link(TASK.replace(/-/g, '').toUpperCase(), 's1', '/code/app', 'start');

  /* Then */
  const expected = { taskId: TASK, projectPath: '/code/app', sessionId: 's1', source: 'start', linkedAt: 1_000 };
  assert.deepEqual(link, expected);
  assert.deepEqual(store.links, [expected]);
});

test('linking with something that is no task id is refused', () => {
  /* Given */
  const { service, store } = setup();

  /* When */
  const attempt = () => service.link('my task', 's1', '/code/app', 'manual');

  /* Then */
  assert.throws(attempt, /Not a task id/);
  assert.deepEqual(store.links, []);
});

test('an unlinked session works on no task', () => {
  /* Given */
  const { service } = setup();
  service.link(TASK, 's1', '/code/app', 'start');

  /* When */
  service.unlink('s1');

  /* Then */
  assert.equal(service.taskOf('s1'), null);
  assert.deepEqual(service.sessionsOf(TASK), []);
});

test('a task with several sessions reports the most recently active one as owner', () => {
  /* Given */
  const { service, clock } = setup([
    { sessionId: 's1', activeAt: 9_000 },
    { sessionId: 's2', activeAt: 5_000 },
  ]);
  service.link(TASK, 's1', '/code/app', 'start');
  clock.at = 2_000;
  service.link(TASK, 's2', '/code/app', 'detected');

  /* When */
  const owner = service.ownerOf(TASK);

  /* Then */
  assert.equal(owner, 's1');
  assert.deepEqual(service.sessionsOf(TASK), ['s2', 's1']);
});

test('an archived session owns no task, and one not listed yet is active from its link', () => {
  /* Given */
  const { service, clock } = setup([{ sessionId: 's1', activeAt: 9_000, archived: true }]);
  service.link(TASK, 's1', '/code/app', 'start');
  clock.at = 2_000;
  service.link(TASK, 's2', '/code/app', 'start');

  /* When */
  const owner = service.ownerOf(TASK);

  /* Then */
  assert.equal(owner, 's2');
});

test('the repo follows the latest link, and setRepo overrides it', () => {
  /* Given */
  const { service, clock } = setup();
  service.link(TASK, 's1', '/code/old', 'start');
  clock.at = 2_000;
  service.link(TASK, 's2', '/code/app', 'start');
  const followed = service.repoOf(TASK);
  clock.at = 3_000;

  /* When */
  service.setRepo(TASK, '/code/right');

  /* Then */
  assert.equal(followed, '/code/app');
  assert.equal(service.repoOf(TASK), '/code/right');
  assert.deepEqual(service.tasksIn('/code/right'), [TASK]);
  assert.deepEqual(service.tasksIn('/code/app'), []);
});

test('a task without links has no repo, no sessions and no owner', () => {
  /* Given */
  const { service } = setup();

  /* When */
  const answers = [service.repoOf(TASK), service.sessionsOf(TASK), service.ownerOf(TASK)];

  /* Then */
  assert.deepEqual(answers, [null, [], null]);
});

test('a scan links a session to the task its blaaktasks call names', () => {
  /* Given */
  const { service } = setup();
  const transcript = [toolCall('mcp__blaaktasks__update', TASK, '1970-01-01T00:00:00.500Z')];

  /* When */
  const linked = service.scan('s1', transcript, '/code/app');

  /* Then */
  assert.deepEqual(linked, { taskId: TASK, projectPath: '/code/app', sessionId: 's1', source: 'detected', linkedAt: 1_000 });
  assert.equal(service.taskOf('s1'), TASK);
});

test('scanning again finds nothing new', () => {
  /* Given */
  const { service, clock } = setup();
  const transcript = [toolCall('mcp__blaaktasks__update', TASK, '1970-01-01T00:00:00.500Z')];
  service.scan('s1', transcript, '/code/app');
  clock.at = 5_000;

  /* When */
  const linked = service.scan('s1', transcript, '/code/app');

  /* Then */
  assert.equal(linked, null);
  assert.equal(service.repoOf(TASK), '/code/app');
});

test('a scan does not undo a link made by hand after the call', () => {
  /* Given */
  const { service } = setup();
  service.link(OTHER, 's1', '/code/app', 'manual');
  const transcript = [toolCall('mcp__blaaktasks__progress', TASK, '1970-01-01T00:00:00.500Z')];

  /* When */
  const linked = service.scan('s1', transcript, '/code/app');

  /* Then */
  assert.equal(linked, null);
  assert.equal(service.taskOf('s1'), OTHER);
});

test('a scan moves the session to a task it named after its link', () => {
  /* Given */
  const { service, clock } = setup();
  service.link(OTHER, 's1', '/code/app', 'start');
  clock.at = 5_000;
  const transcript = [toolCall('mcp__blaaktasks__progress', TASK, '1970-01-01T00:00:02.000Z')];

  /* When */
  const linked = service.scan('s1', transcript, '/code/app');

  /* Then */
  assert.equal(linked?.taskId, TASK);
  assert.equal(service.taskOf('s1'), TASK);
});

test('an unlinked session stays unlinked when the same transcript is scanned again', () => {
  /* Given */
  const { service, clock } = setup();
  const transcript = [toolCall('mcp__blaaktasks__update', TASK, '1970-01-01T00:00:00.500Z')];
  service.scan('s1', transcript, '/code/app');
  clock.at = 2_000;
  service.unlink('s1');
  clock.at = 3_000;

  /* When */
  const linked = service.scan('s1', transcript, '/code/app');

  /* Then */
  assert.equal(linked, null);
  assert.equal(service.taskOf('s1'), null);
});

test('an unlinked session links again from a call made after the unlink', () => {
  /* Given */
  const { service, clock } = setup();
  service.link(TASK, 's1', '/code/app', 'detected');
  clock.at = 2_000;
  service.unlink('s1');
  clock.at = 4_000;
  const transcript = [
    toolCall('mcp__blaaktasks__update', TASK, '1970-01-01T00:00:00.500Z'),
    toolCall('mcp__blaaktasks__progress', OTHER, '1970-01-01T00:00:03.000Z'),
  ];

  /* When */
  const linked = service.scan('s1', transcript, '/code/app');

  /* Then */
  assert.equal(linked?.taskId, OTHER);
  assert.equal(service.taskOf('s1'), OTHER);
});

test('a transcript without a blaaktasks call links nothing', () => {
  /* Given */
  const { service } = setup();
  const transcript = [JSON.stringify({ type: 'user', message: { role: 'user', content: 'work on my task ' + TASK } })];

  /* When */
  const linked = service.scan('s1', transcript, '/code/app');

  /* Then */
  assert.equal(linked, null);
  assert.equal(service.taskOf('s1'), null);
});

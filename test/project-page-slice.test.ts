/**
 * The project page's own state (#173): its plans expanded and Show closed,
 * remembered per project, the cursor and the filter, which start empty each
 * time the page opens; and the Sessions section's choice of sessions.
 *
 * The route into and out of the page is tested in test/main-area-slice.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialRendererState, rootReducer } from '../src/renderer/state/root';
import {
  NO_MEMORY, memoryOf, parseProjectPageMemories, projectPageMemory, remembered, steppedCursor,
} from '../src/renderer/state/project-page-slice';
import { projectRoute } from '../src/renderer/state/main-area-slice';
import { projectSessions } from '../src/renderer/ui/project-page/project-sessions';
import { repositoryRoot, worktreeName } from '../src/renderer/features/sessions/project-label';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';
import type { Project } from '../src/domain/project/project';
import type { SessionRow } from '../src/domain/session/session';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const APP = '/dev/app';

function opened(projectPath = APP, memory = NO_MEMORY): RendererState {
  return run(initialRendererState(), { type: 'projectPageRestored', projectPath, memory });
}

// ── The slice ──

test('a page opens on what its project remembered, with no cursor and no filter', () => {
  /* Given */
  const before = run(opened('/dev/other'), { type: 'projectCursorMoved', target: 'plan:a#1' }, { type: 'projectFilterChanged', filter: 'login' });

  /* When */
  const state = run(before, { type: 'projectPageRestored', projectPath: APP, memory: { expandedPlans: ['acme/app#121'], showClosed: true } });

  /* Then */
  assert.deepEqual(state.projectPage, {
    projectPath: APP, expandedPlans: ['acme/app#121'], showClosed: true, cursor: null, filter: '',
    overview: null, looseExpanded: false, start: null,
  });
});

test('toggling a plan expands it, and toggling it again collapses it', () => {
  /* Given */
  const state = opened();

  /* When */
  const expanded = run(state, { type: 'projectPlanToggled', plan: 'acme/app#121' }, { type: 'projectPlanToggled', plan: 'acme/app#130' });
  const collapsed = run(expanded, { type: 'projectPlanToggled', plan: 'acme/app#121' });

  /* Then */
  assert.deepEqual(expanded.projectPage.expandedPlans, ['acme/app#121', 'acme/app#130']);
  assert.deepEqual(collapsed.projectPage.expandedPlans, ['acme/app#130']);
});

test('Show closed flips each time it is toggled', () => {
  /* Given */
  const state = opened();

  /* When */
  const shown = run(state, { type: 'projectShowClosedToggled' });
  const hidden = run(shown, { type: 'projectShowClosedToggled' });

  /* Then */
  assert.equal(shown.projectPage.showClosed, true);
  assert.equal(hidden.projectPage.showClosed, false);
});

test('before any page has opened, toggles change nothing', () => {
  /* Given */
  const state = initialRendererState();

  /* When */
  const next = run(state, { type: 'projectPlanToggled', plan: 'acme/app#121' }, { type: 'projectShowClosedToggled' });

  /* Then */
  assert.equal(next, state);
});

test('the cursor and the filter are kept as given, and the same value again notifies nobody', () => {
  /* Given */
  const state = run(opened(), { type: 'projectCursorMoved', target: 'session:s1' }, { type: 'projectFilterChanged', filter: 'login' });

  /* When */
  const again = run(state, { type: 'projectCursorMoved', target: 'session:s1' }, { type: 'projectFilterChanged', filter: 'login' });

  /* Then */
  assert.equal(state.projectPage.cursor, 'session:s1');
  assert.equal(state.projectPage.filter, 'login');
  assert.equal(again, state);
});

test('the memory to persist is the expanded plans and Show closed, not the cursor or the filter', () => {
  /* Given */
  const state = run(opened(), { type: 'projectPlanToggled', plan: 'acme/app#121' }, { type: 'projectCursorMoved', target: 'x' });

  /* When */
  const memory = projectPageMemory(state.projectPage);

  /* Then */
  assert.deepEqual(memory, { expandedPlans: ['acme/app#121'], showClosed: false });
});

// ── The cursor across sections ──

test('down from no cursor lands on the first row, and up on the last', () => {
  /* Given */
  const rows = ['plan:1', 'issue:2', 'session:s1'];

  /* When */
  const down = steppedCursor(rows, null, 1);
  const up = steppedCursor(rows, null, -1);

  /* Then */
  assert.equal(down, 'plan:1');
  assert.equal(up, 'session:s1');
});

test('the cursor steps from one section into the next, and holds at either end', () => {
  /* Given */
  const rows = ['plan:1', 'issue:2', 'session:s1'];

  /* When */
  const across = steppedCursor(rows, 'issue:2', 1);
  const atEnd = steppedCursor(rows, 'session:s1', 1);
  const atStart = steppedCursor(rows, 'plan:1', -1);

  /* Then */
  assert.equal(across, 'session:s1');
  assert.equal(atEnd, 'session:s1');
  assert.equal(atStart, 'plan:1');
});

test('a cursor on a row that has gone starts over, and no rows means no cursor', () => {
  /* When */
  const gone = steppedCursor(['a', 'b'], 'c', 1);
  const none = steppedCursor([], 'a', 1);

  /* Then */
  assert.equal(gone, 'a');
  assert.equal(none, null);
});

// ── Remembered per project ──

test('each project remembers its own plans and Show closed', () => {
  /* Given */
  const stored = JSON.stringify(remembered(remembered({}, APP, { expandedPlans: ['acme/app#121'], showClosed: true }), '/dev/web', { expandedPlans: [], showClosed: true }));

  /* When */
  const memories = parseProjectPageMemories(stored);

  /* Then */
  assert.deepEqual(memoryOf(memories, APP), { expandedPlans: ['acme/app#121'], showClosed: true });
  assert.deepEqual(memoryOf(memories, '/dev/web'), { expandedPlans: [], showClosed: true });
  assert.deepEqual(memoryOf(memories, '/dev/new'), NO_MEMORY);
});

test('a project put back the way it opens is forgotten rather than stored', () => {
  /* Given */
  const memories = remembered({}, APP, { expandedPlans: ['acme/app#121'], showClosed: false });

  /* When */
  const next = remembered(memories, APP, NO_MEMORY);

  /* Then */
  assert.deepEqual(next, {});
});

test('nothing stored, or something that is not ours, reads as nothing remembered', () => {
  /* When */
  const empty = parseProjectPageMemories(null);
  const garbled = parseProjectPageMemories('{not json');
  const wrong = parseProjectPageMemories('[1, 2]');
  const odd = parseProjectPageMemories(JSON.stringify({ [APP]: { expandedPlans: ['acme/app#1', 7], showClosed: 'yes' } }));

  /* Then */
  assert.deepEqual(empty, {});
  assert.deepEqual(garbled, {});
  assert.deepEqual(wrong, {});
  assert.deepEqual(odd, { [APP]: { expandedPlans: ['acme/app#1'], showClosed: false } });
});

// ── The route ──

test('the project route names the project and its view, and nothing else does', () => {
  /* Given */
  const state = run(initialRendererState(), { type: 'projectOpened', projectPath: APP, view: { kind: 'overview' } });

  /* When */
  const route = projectRoute(state.mainArea);
  const none = projectRoute(initialRendererState().mainArea);

  /* Then */
  assert.deepEqual(route, { projectPath: APP, view: { kind: 'overview' } });
  assert.equal(none, null);
});

// ── The Sessions section ──

function session(id: string, projectPath: string, modified: string): SessionRow {
  return {
    sessionId: id, summary: id, firstPrompt: '', projectPath, created: modified, modified,
    messageCount: 1, name: null, starred: 0, archived: 0,
  };
}

function project(projectPath: string, ...sessions: SessionRow[]): Project {
  return { projectPath, folder: projectPath, sessions };
}

test('a worktree belongs to its repository, and is named by its folder', () => {
  /* When */
  const root = repositoryRoot(APP + '/.claude/worktrees/issue-173');
  const name = worktreeName(APP + '/.claude/worktrees/issue-173');

  /* Then */
  assert.equal(root, APP);
  assert.equal(name, 'issue-173');
  assert.equal(repositoryRoot(APP), APP);
  assert.equal(worktreeName(APP), null);
});

test('the section lists the repository\'s and its worktrees\' sessions, running first, then the latest', () => {
  /* Given */
  const worktree = APP + '/.claude/worktrees/issue-173';
  const projects = [
    project(APP, session('old', APP, '2026-10-01T10:00:00Z'), session('new', APP, '2026-10-20T10:00:00Z')),
    project(worktree, session('wt', worktree, '2026-10-10T10:00:00Z')),
    project('/dev/other', session('elsewhere', '/dev/other', '2026-10-21T10:00:00Z')),
  ];

  /* When */
  const { lines, total } = projectSessions(projects, APP, new Set(['old']));

  /* Then */
  assert.deepEqual(lines.map(l => [l.session.sessionId, l.running, l.worktree]), [
    ['old', true, null],
    ['new', false, null],
    ['wt', false, 'issue-173'],
  ]);
  assert.equal(total, 3);
});

test('the section lists five sessions and counts them all', () => {
  /* Given */
  const sessions = Array.from({ length: 7 }, (_, i) => session('s' + i, APP, `2026-10-1${i}T10:00:00Z`));

  /* When */
  const { lines, total } = projectSessions([project(APP, ...sessions)], APP, new Set());

  /* Then */
  assert.deepEqual(lines.map(l => l.session.sessionId), ['s6', 's5', 's4', 's3', 's2']);
  assert.equal(total, 7);
});

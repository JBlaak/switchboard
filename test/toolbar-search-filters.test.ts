import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchingProjectPaths, projectsToRender } from '../src/renderer/state/search-narrowing';
import { initialViewState, isFilteringView } from '../src/renderer/state/view-slice';
import type { SearchNarrowing } from '../src/renderer/state/search-narrowing';
import type { Project } from '../src/domain/project/project';
import type { SessionRow } from '../src/domain/session/session';

function session(id: string, archived = 0): SessionRow {
  return {
    sessionId: id, summary: 'Session ' + id, firstPrompt: '', projectPath: '/p',
    created: '2026-01-01T00:00:00Z', modified: '2026-01-01T00:00:00Z',
    messageCount: 1, name: null, starred: 0, archived,
  };
}

function project(projectPath: string, ...sessions: SessionRow[]): Project {
  return { projectPath, folder: projectPath, sessions };
}

const NO_SEARCH: SearchNarrowing = { showArchived: false, searchMatchIds: null, searchMatchProjectPaths: null };

const searched = (ids: string[], paths: string[] | null = null): SearchNarrowing =>
  ({ ...NO_SEARCH, searchMatchIds: new Set(ids), searchMatchProjectPaths: paths && new Set(paths) });

const sessionIds = (projects: readonly Project[]) => projects.flatMap(p => p.sessions.map(s => s.sessionId));

/** The unarchived list, and the full one with the archived sessions in it. */
const ACTIVE = [project('/dev/api', session('login')), project('/dev/web-dash', session('charts'), session('deps'))];
const ALL = [
  project('/dev/api', session('login'), session('graphql', 1)),
  project('/dev/web-dash', session('charts'), session('deps')),
  project('/notes', session('meeting', 1)),
];

// ── Which projects are laid out ──

test('with no search, the list is laid out from the unarchived projects', () => {
  /* When */
  const projects = projectsToRender(ACTIVE, ALL, NO_SEARCH);

  /* Then */
  assert.equal(projects, ACTIVE);
});

test('the archived filter lays it out from all of them', () => {
  /* When */
  const projects = projectsToRender(ACTIVE, ALL, { ...NO_SEARCH, showArchived: true });

  /* Then */
  assert.equal(projects, ALL);
});

test('a search ignores the archive filter and covers every project', () => {
  /* When */
  const projects = projectsToRender(ACTIVE, ALL, searched(['graphql', 'meeting']));

  /* Then */
  assert.deepEqual(projects.map(p => p.projectPath), ['/dev/api', '/notes']);
  assert.deepEqual(sessionIds(projects), ['graphql', 'meeting']);
});

test('a search narrows each project to its matching sessions', () => {
  /* When */
  const projects = projectsToRender(ACTIVE, ALL, searched(['charts']));

  /* Then */
  assert.deepEqual(sessionIds(projects), ['charts']);
});

test('a project matched by name shows all of its sessions', () => {
  /* When */
  const projects = projectsToRender(ACTIVE, ALL, searched([], ['/dev/web-dash']));

  /* Then */
  assert.deepEqual(sessionIds(projects), ['charts', 'deps']);
});

// ── Titles only: projects matched by name ──

test('a project matches when its short name contains the query, in any case', () => {
  /* When */
  const matched = matchingProjectPaths('WEB-DA', ALL);

  /* Then */
  assert.deepEqual(matched, new Set(['/dev/web-dash']));
});

test('a query no project name contains matches none', () => {
  /* When */
  const matched = matchingProjectPaths('billing', ALL);

  /* Then */
  assert.equal(matched, null);
});

// ── Filtering, which hides the section labels ──

test('the list starts with no filter on and no search', () => {
  /* When */
  const view = initialViewState();

  /* Then */
  assert.equal(isFilteringView(view), false);
});

test('any filter, or a search, counts as filtering', () => {
  /* Given */
  const view = initialViewState();

  /* When */
  const filtering = [
    { showArchived: true }, { showStarredOnly: true }, { showRunningOnly: true }, { showTodayOnly: true },
    { searchMatchIds: new Set<string>() },
  ].map(patch => isFilteringView({ ...view, ...patch }));

  /* Then */
  assert.deepEqual(filtering, [true, true, true, true, true]);
});

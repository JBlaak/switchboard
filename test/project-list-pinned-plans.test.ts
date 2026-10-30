import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectList } from '../src/domain/project/project-list';
import type { CachedSession } from '../src/domain/session/session';
import type { IssuePlanPin, PlanPin } from '../src/domain/project/project-list';

function cached(sessionId: string, projectPath: string, slug: string): CachedSession {
  return {
    sessionId, folder: projectPath.replace(/\//g, '-'), projectPath, summary: sessionId, firstPrompt: '',
    created: '2026-10-01T00:00:00.000Z', modified: '2026-10-01T00:00:00.000Z', messageCount: 1, slug,
  } as CachedSession;
}

function build(pinnedPlans: PlanPin[], pinnedIssuePlans: IssuePlanPin[] = []) {
  return buildProjectList({
    cached: [cached('a', '/one', 'plan'), cached('b', '/two', 'plan')],
    meta: new Map(),
    hiddenProjects: new Set(['/hidden']),
    knownProjectPaths: [],
    activeTerminals: [],
    remoteProjects: [],
    pinnedPlans,
    pinnedIssuePlans,
    showArchived: false,
  });
}

test('a pinned plan lands on its own project only', () => {
  /* When */
  const projects = build([{ projectPath: '/one', slug: 'plan' }]);

  /* Then */
  assert.deepEqual(projects.find(p => p.projectPath === '/one')?.pinnedPlans, ['plan']);
  assert.equal(projects.find(p => p.projectPath === '/two')?.pinnedPlans, undefined);
});

test('a pin on a project without a row is left out', () => {
  /* When */
  const projects = build([{ projectPath: '/hidden', slug: 'plan' }, { projectPath: '/gone', slug: 'plan' }]);

  /* Then */
  assert.deepEqual(projects.map(p => p.projectPath).sort(), ['/one', '/two']);
  assert.ok(projects.every(p => p.pinnedPlans === undefined));
});

test('a pinned GitHub plan lands on the project it was pinned in', () => {
  /* Given */
  const pin = { projectPath: '/one', repository: 'acme/app', number: 12, title: 'Redesign', pinnedAt: 1 };

  /* When */
  const projects = build([], [pin, { ...pin, projectPath: '/gone' }]);

  /* Then */
  assert.deepEqual(projects.find(p => p.projectPath === '/one')?.pinnedIssuePlans,
    [{ repository: 'acme/app', number: 12, title: 'Redesign', pinnedAt: 1 }]);
  assert.equal(projects.find(p => p.projectPath === '/two')?.pinnedIssuePlans, undefined);
});

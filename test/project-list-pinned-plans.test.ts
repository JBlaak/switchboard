import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectList } from '../src/domain/project/project-list';
import type { CachedSession } from '../src/domain/session/session';
import type { PlanPin } from '../src/domain/project/project-list';

function cached(sessionId: string, projectPath: string, slug: string): CachedSession {
  return {
    sessionId, folder: projectPath.replace(/\//g, '-'), projectPath, summary: sessionId, firstPrompt: '',
    created: '2026-10-01T00:00:00.000Z', modified: '2026-10-01T00:00:00.000Z', messageCount: 1, slug,
  } as CachedSession;
}

function build(pinnedPlans: PlanPin[]) {
  return buildProjectList({
    cached: [cached('a', '/one', 'plan'), cached('b', '/two', 'plan')],
    meta: new Map(),
    hiddenProjects: new Set(['/hidden']),
    knownProjectPaths: [],
    activeTerminals: [],
    remoteProjects: [],
    pinnedPlans,
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

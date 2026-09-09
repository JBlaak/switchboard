import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectList } from '../src/domain/project/project-list';
import type { ProjectListInputs } from '../src/domain/project/project-list';
import type { CachedSession } from '../src/domain/session/session';

/**
 * A row carries the directory its session ran in, which projectPath loses when
 * a worktree is folded into the repository it was cut from. The cwd is a
 * property of the transcript folder, so the list stamps it from the folder gate
 * rather than storing it per row — and a folder the gate has no cwd for (one
 * indexed before it was recorded) leaves the row null, for readers to fall back
 * to projectPath.
 */

const PROJECT = '/Users/x/proj';
const WORKTREE = '/Users/x/proj/.claude/worktrees/feat';

function cachedRow(sessionId: string, folder: string): CachedSession {
  return {
    sessionId,
    folder,
    projectPath: PROJECT,
    summary: sessionId,
    firstPrompt: sessionId,
    created: '2026-01-01T00:00:00Z',
    modified: '2026-01-01T00:00:00Z',
    fileMtime: '2026-01-01T00:00:00Z',
    messageCount: 1,
    slug: null,
    aiTitle: null,
  };
}

function inputs(overrides: Partial<ProjectListInputs>): ProjectListInputs {
  return {
    cached: [],
    meta: new Map(),
    hiddenProjects: new Set(),
    knownProjectPaths: [],
    folderCwds: new Map(),
    activeTerminals: [],
    remoteProjects: [],
    showArchived: false,
    ...overrides,
  };
}

test('rows are stamped with the cwd of the folder they came from', () => {
  const list = buildProjectList(inputs({
    cached: [
      cachedRow('in-worktree', 'proj-wt'),
      cachedRow('in-root', 'proj'),
      cachedRow('legacy', 'proj-old'),
    ],
    folderCwds: new Map([
      ['proj-wt', WORKTREE],
      ['proj', PROJECT],
      ['proj-old', null],
    ]),
  }));

  assert.equal(list.length, 1, 'three folders, one project: the fold still groups them');
  const cwdOf = new Map(list[0].sessions.map(s => [s.sessionId, s.cwd]));
  assert.equal(cwdOf.get('in-worktree'), WORKTREE, 'a worktree row keeps the directory it ran in');
  assert.equal(cwdOf.get('in-root'), PROJECT, 'a root row\'s cwd is its project path');
  assert.equal(cwdOf.get('legacy'), null, 'a gate without a cwd yet leaves the row null');
});

test('a folder the gate does not know at all leaves cwd null too', () => {
  const list = buildProjectList(inputs({
    cached: [cachedRow('orphan', 'proj-unknown')],
  }));

  assert.equal(list[0].sessions[0].cwd, null);
  assert.equal(list[0].sessions[0].projectPath, PROJECT, 'projectPath is still there to fall back to');
});

test('a row that never touched disk has no cwd to report', () => {
  const list = buildProjectList(inputs({
    activeTerminals: [{ sessionId: 'term', projectPath: PROJECT, openedAt: Date.UTC(2026, 0, 1) }],
  }));

  assert.equal(list[0].sessions[0].type, 'terminal');
  assert.equal(list[0].sessions[0].cwd, null);
});

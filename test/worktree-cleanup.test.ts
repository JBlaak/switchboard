import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worktreeVerdicts } from '../src/domain/session-work/worktree-cleanup';
import { WorktreeCleanupService } from '../src/application/services/worktree-cleanup-service';
import type { WorktreeCleanupDeps } from '../src/application/services/worktree-cleanup-service';
import type { WorktreeSummary } from '../src/domain/project/overview';
import type { TranscriptLocation } from '../src/application/ports/transcript-store';

const REPO = '/code/app';
const LINKED = '/code/app/.claude/worktrees/117-overlay';

function checkout(path: string, overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    path, branch: '117-overlay', main: false, locked: false, changedFiles: 0, ahead: 2, merged: false, lastCommitAt: null,
    ...overrides,
  };
}

// ── The rule ──

test('a clean linked worktree on a branch is removed, unmerged commits and all', () => {
  /* Given */
  const checkouts = [checkout(REPO, { main: true, branch: 'main' }), checkout(LINKED, { ahead: 5 })];

  /* When */
  const verdicts = worktreeVerdicts([LINKED], checkouts, []);

  /* Then */
  assert.deepEqual(verdicts, [{ path: LINKED, remove: true }]);
});

test('a worktree is kept for anything removing it would lose or break, with the reason', () => {
  /* Given */
  const checkouts = [
    checkout(REPO, { main: true, branch: 'main' }),
    checkout('/w/locked', { locked: true }),
    checkout('/w/detached', { branch: null }),
    checkout('/w/dirty', { changedFiles: 1 }),
    checkout('/w/shared'),
  ];

  /* When */
  const verdicts = worktreeVerdicts(
    [REPO, '/w/locked', '/w/detached', '/w/dirty', '/w/shared', '/w/unknown'],
    checkouts,
    ['/w/shared/packages/web'],
  );

  /* Then */
  assert.deepEqual(verdicts.map((verdict) => verdict.remove ? 'remove' : verdict.reason), [
    'the main checkout',
    'locked',
    'on a detached HEAD',
    'has uncommitted changes',
    'another session works in it',
    'not a worktree git lists',
  ]);
});

test('another session in a sibling directory with a longer name does not keep a worktree', () => {
  /* Given */
  const checkouts = [checkout('/w/117')];

  /* When */
  const verdicts = worktreeVerdicts(['/w/117'], checkouts, ['/w/117-other']);

  /* Then */
  assert.deepEqual(verdicts, [{ path: '/w/117', remove: true }]);
});

// ── The service ──

function harness({
  enabled = true,
  projectPath = REPO,
  written = [] as TranscriptLocation[],
  checkouts = [checkout(REPO, { main: true, branch: 'main' }), checkout(LINKED)],
  others = [] as string[],
  refuse = null as string | null,
} = {}) {
  const removed: [string, string][] = [];
  const logged: string[] = [];
  const deps: WorktreeCleanupDeps = {
    enabled: () => enabled,
    locate: (sessionId) => sessionId === 's1' ? { folder: '-code-app', projectPath } : null,
    transcripts: { locations: () => written },
    git: {
      async worktreeRoot(cwd) {
        if (cwd.startsWith(LINKED)) return LINKED;
        return cwd.startsWith(REPO) ? REPO : null;
      },
      async mainCheckout(cwd) {
        return cwd.startsWith(REPO) ? REPO : null;
      },
      async worktrees(repository) {
        return repository === REPO ? checkouts : [];
      },
      async removeWorktree(repository, path) {
        removed.push([repository, path]);
        return refuse ? { ok: false, reason: refuse } : { ok: true };
      },
    },
    otherSessionPaths: () => others,
    log: {
      debug() {}, warn: (message: string) => { logged.push(message); },
      info: (message: string) => { logged.push(message); }, error() {},
    },
  };
  return { service: new WorktreeCleanupService(deps), removed, logged };
}

const IN_LINKED: TranscriptLocation = { cwd: LINKED + '/src', branch: '117-overlay', fromSubagent: false };

test('archiving removes the linked worktree the transcripts worked in, from its repository, and keeps the main checkout', async () => {
  /* Given */
  const h = harness({ written: [{ cwd: REPO, branch: 'main', fromSubagent: false }, IN_LINKED] });

  /* When */
  await h.service.afterArchive('s1');

  /* Then */
  assert.deepEqual(h.removed, [[REPO, LINKED]]);
  assert.deepEqual(h.logged, [`[worktree-cleanup] s1: removed ${LINKED}`]);
});

test('a session started in the worktree itself has it removed', async () => {
  /* Given */
  const h = harness({ projectPath: LINKED });

  /* When */
  await h.service.afterArchive('s1');

  /* Then */
  assert.deepEqual(h.removed, [[REPO, LINKED]]);
});

test('with the setting off, nothing is removed', async () => {
  /* Given */
  const h = harness({ enabled: false, written: [IN_LINKED] });

  /* When */
  await h.service.afterArchive('s1');

  /* Then */
  assert.deepEqual(h.removed, []);
});

test('a worktree another session works in is kept, and says why', async () => {
  /* Given */
  const h = harness({ written: [IN_LINKED], others: [LINKED] });

  /* When */
  await h.service.afterArchive('s1');

  /* Then */
  assert.deepEqual(h.removed, []);
  assert.deepEqual(h.logged, [`[worktree-cleanup] s1: kept ${LINKED}, another session works in it`]);
});

test('a remote session is left alone', async () => {
  /* Given */
  const h = harness({ projectPath: 'ssh://mac-mini/code/app', written: [IN_LINKED] });

  /* When */
  await h.service.afterArchive('s1');

  /* Then */
  assert.deepEqual(h.removed, []);
});

test('git refusing a removal is logged with its reason', async () => {
  /* Given */
  const h = harness({ written: [IN_LINKED], refuse: "'117-overlay' contains modified or untracked files, use --force to delete it" });

  /* When */
  await h.service.afterArchive('s1');

  /* Then */
  assert.deepEqual(h.logged, [
    `[worktree-cleanup] s1: could not remove ${LINKED}: '117-overlay' contains modified or untracked files, use --force to delete it`,
  ]);
});

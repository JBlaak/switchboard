/**
 * Which worktrees the project page's Clean removes: linked, unlocked, clean,
 * merged and with no session running, all at once.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {superfluousWorktrees} from '../src/domain/project/superfluous-worktrees';
import type {WorktreeOverview} from '../src/domain/project/overview';

function worktree(path: string, overrides: Partial<WorktreeOverview> = {}): WorktreeOverview {
    return {
        path,
        branch: 'done',
        main: false,
        locked: false,
        changedFiles: 0,
        ahead: 0,
        merged: true,
        lastCommitAt: null,
        running: [],
        ...overrides,
    };
}

test('a merged, clean, unlocked linked worktree with no session running is superfluous', () => {
    /* Given */
    const worktrees = [worktree('/w/done'), worktree('/w/also-done', {branch: 'also-done'})];

    /* When */
    const superfluous = superfluousWorktrees(worktrees);

    /* Then */
    assert.deepEqual(
        superfluous.map((w) => w.path),
        ['/w/done', '/w/also-done'],
    );
});

test('the main checkout, a locked, dirty, unmerged or busy worktree is kept', () => {
    /* Given */
    const worktrees = [
        worktree('/w/main', {main: true, branch: 'main'}),
        worktree('/w/locked', {locked: true}),
        worktree('/w/dirty', {changedFiles: 1}),
        worktree('/w/unmerged', {merged: false, ahead: 2}),
        worktree('/w/detached', {branch: null, merged: false}),
        worktree('/w/busy', {running: ['session-1']}),
        worktree('/w/done'),
    ];

    /* When */
    const superfluous = superfluousWorktrees(worktrees);

    /* Then */
    assert.deepEqual(
        superfluous.map((w) => w.path),
        ['/w/done'],
    );
});

test('no worktrees: nothing is superfluous', () => {
    /* When */
    const superfluous = superfluousWorktrees([]);

    /* Then */
    assert.deepEqual(superfluous, []);
});

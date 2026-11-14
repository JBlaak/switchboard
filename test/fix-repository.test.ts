/**
 * A Fix session's repository, read off its worktree (#414): the session list
 * names that, with a bug, instead of the `fix/bugsnag-…` worktree.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixBranch, fixRepository} from '../src/domain/inbox/fix';

test("a Fix's worktree names the repository it was cut from", () => {
    /* Given */
    const worktree = `/code/movelab-app/.claude/worktrees/${fixBranch('6af61c2e00000000')}`;

    /* When */
    const repository = fixRepository(worktree);

    /* Then */
    assert.equal(repository, '/code/movelab-app');
});

test('any other path is not a Fix', () => {
    /* When */
    const others = [
        fixRepository('/code/movelab-app'),
        fixRepository('/code/movelab-app/.claude/worktrees/feat-x'),
        fixRepository('/code/movelab-app/.claude/worktrees/fix/other-thing'),
        fixRepository(null),
    ];

    /* Then */
    assert.deepEqual(others, [null, null, null, null]);
});

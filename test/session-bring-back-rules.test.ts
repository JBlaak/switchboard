import {test} from 'node:test';
import assert from 'node:assert/strict';

import {rewriteBroughtBackCwd, vmCheckout} from '../src/domain/agent/session-bring-back';

/**
 * The pure parts of a session's Bring back from a VM (#276): which of the
 * copy's checkouts the session works in, and the transcript's `cwd` moved to
 * the Mac.
 */

const HOME = '/home/dev';
const COPY = '/home/dev/projects/site';
const LOCAL = '/Users/joris/Development/site/.claude/worktrees/fix-login';

// ── Which checkout ──

test('a session in a worktree of the copy is in that worktree, by its folder name', () => {
    /* When */
    const checkout = vmCheckout(`${COPY}/.claude/worktrees/fix-login/src`, COPY);

    /* Then */
    assert.deepEqual(checkout, {kind: 'worktree', name: 'fix-login', dir: `${COPY}/.claude/worktrees/fix-login`});
});

test("a session in the copy's own folder, or below it, is in the copy", () => {
    /* When */
    const top = vmCheckout(COPY + '/', COPY);
    const below = vmCheckout(`${COPY}/src`, COPY);

    /* Then */
    assert.deepEqual(top, {kind: 'main', dir: COPY});
    assert.deepEqual(below, {kind: 'main', dir: COPY});
});

test('a session outside the copy has nothing to bring back', () => {
    /* When */
    const elsewhere = vmCheckout('/home/dev/projects/site-old', COPY);

    /* Then */
    assert.ok('error' in elsewhere);
});

// ── The transcript ──

test("both the VM's absolute cwd and the hand-off's ~ form move to the Mac's checkout", () => {
    /* Given */
    const raw = [
        '{"type":"user","cwd":"~/projects/site/.claude/worktrees/fix-login","message":"from the Mac"}',
        '{"type":"user","cwd":"/home/dev/projects/site/.claude/worktrees/fix-login/src","message":"on the VM"}',
        '{"type":"summary","summary":"Fix it"}',
        '',
    ].join('\n');

    /* When */
    const moved = rewriteBroughtBackCwd(raw, `${COPY}/.claude/worktrees/fix-login`, HOME, LOCAL);

    /* Then */
    assert.equal(
        moved,
        [
            `{"type":"user","cwd":"${LOCAL}","message":"from the Mac"}`,
            `{"type":"user","cwd":"${LOCAL}/src","message":"on the VM"}`,
            '{"type":"summary","summary":"Fix it"}',
            '',
        ].join('\n'),
    );
});

test('a cwd outside the checkout is left as written', () => {
    /* Given */
    const raw = '{"type":"user","cwd":"/tmp/elsewhere"}\n';

    /* When */
    const moved = rewriteBroughtBackCwd(raw, COPY, HOME, LOCAL);

    /* Then */
    assert.equal(moved, raw);
});

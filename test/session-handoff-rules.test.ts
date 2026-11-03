import {test} from 'node:test';
import assert from 'node:assert/strict';

import {rewriteTranscriptCwd, sessionCheckout} from '../src/domain/agent/session-handoff';

/**
 * The pure parts of a session hand-off (#276 stage 3): which checkout a
 * session works in, and the transcript's `cwd` moved to the VM.
 */

const ROOT = '/Users/joris/Development/site';

// ── Which checkout ──

test("a session in the repository's own checkout is in the main checkout", () => {
    /* When */
    const checkout = sessionCheckout(ROOT, `${ROOT}/.git`);

    /* Then */
    assert.deepEqual(checkout, {kind: 'main', checkout: ROOT, root: ROOT});
});

test('a session in a Claude worktree is in that worktree, by its folder name', () => {
    /* When */
    const checkout = sessionCheckout(`${ROOT}/.claude/worktrees/fix-login`, `${ROOT}/.git/`);

    /* Then */
    assert.deepEqual(checkout, {
        kind: 'worktree',
        name: 'fix-login',
        checkout: `${ROOT}/.claude/worktrees/fix-login`,
        root: ROOT,
    });
});

test('a linked worktree kept elsewhere is named after its own folder', () => {
    /* When */
    const checkout = sessionCheckout('/Users/joris/wt/site-spike', `${ROOT}/.git`);

    /* Then */
    assert.deepEqual(checkout, {
        kind: 'worktree',
        name: 'site-spike',
        checkout: '/Users/joris/wt/site-spike',
        root: ROOT,
    });
});

test('a repository without a main checkout cannot be handed off', () => {
    /* When */
    const checkout = sessionCheckout('/Users/joris/super/lib', '/Users/joris/super/.git/modules/lib');

    /* Then */
    assert.ok('error' in checkout);
});

// ── The transcript rewrite ──

test("only each line's own cwd changes, every other byte stays as written", () => {
    /* Given */
    const lines = [
        `{"parentUuid":null,"cwd":"${ROOT}","sessionId":"s1","gitBranch":"main","message":{"role":"user","content":"look at ${ROOT}/src/a.ts and \\"cwd\\":\\"${ROOT}\\""}}`,
        `{"type":"assistant","cwd":"${ROOT}/packages/web","message":{"content":[{"type":"tool_use","input":{"cwd":"${ROOT}","file_path":"${ROOT}/x.ts"}}]},"n":1.50}`,
        `{"type":"summary","summary":"no cwd here"}`,
        `{"cwd":"/Users/joris/Development/site-other","x":1}`,
        'not json at all',
        '',
    ];

    /* When */
    const rewritten = rewriteTranscriptCwd(lines.join('\n'), ROOT, '~/projects/site');

    /* Then */
    assert.deepEqual(rewritten.split('\n'), [
        lines[0].replace(`"cwd":"${ROOT}"`, '"cwd":"~/projects/site"'),
        lines[1].replace(`"cwd":"${ROOT}/packages/web"`, '"cwd":"~/projects/site/packages/web"'),
        lines[2],
        lines[3],
        lines[4],
        '',
    ]);
});

test('a worktree checkout moves to the VM worktree, carriage returns and escapes kept', () => {
    /* Given */
    const worktree = `${ROOT}/.claude/worktrees/fix-login`;
    const line = `{"cwd": "${worktree}" ,"text":"caf\\u00e9 \\/ done"}\r`;

    /* When */
    const rewritten = rewriteTranscriptCwd(line, worktree, '/home/dev/projects/site/.claude/worktrees/fix-login');

    /* Then */
    assert.equal(
        rewritten,
        `{"cwd": "/home/dev/projects/site/.claude/worktrees/fix-login" ,"text":"caf\\u00e9 \\/ done"}\r`,
    );
});

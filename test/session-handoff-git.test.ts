import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {GitCliHandoff} from '../src/infrastructure/git/git-cli-handoff';
import {sessionCheckout} from '../src/domain/agent/session-handoff';

/**
 * Telling a session's worktree from its project's own checkout, with real git
 * (#276 stage 3): the common dir is what links a worktree to its repository.
 */

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = os.devNull;

const git = new GitCliHandoff();
let tmp: string;
let repo: string;
let worktree: string;

function run(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-session-handoff-')));
    repo = path.join(tmp, 'site');
    fs.mkdirSync(repo);
    run(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    run(repo, 'add', '-A');
    run(repo, 'commit', '-q', '-m', 'first');
    worktree = path.join(repo, '.claude', 'worktrees', 'fix-login');
    run(repo, 'worktree', 'add', '-q', '-b', 'fix-login', worktree);
    fs.mkdirSync(path.join(worktree, 'src'));
});

after(() => {
    fs.rmSync(tmp, {recursive: true, force: true});
});

test("the main checkout's common dir is its own .git", async () => {
    /* When */
    const [top, common] = await Promise.all([git.repositoryRoot(repo), git.commonDir(repo)]);

    /* Then */
    assert.deepEqual(sessionCheckout(top ?? '', common ?? ''), {kind: 'main', checkout: repo, root: repo});
});

test("a worktree's common dir is the main checkout's .git, from any folder inside it", async () => {
    /* Given */
    const cwd = path.join(worktree, 'src');

    /* When */
    const [top, common] = await Promise.all([git.repositoryRoot(cwd), git.commonDir(cwd)]);

    /* Then */
    assert.deepEqual(sessionCheckout(top ?? '', common ?? ''), {
        kind: 'worktree',
        name: 'fix-login',
        checkout: worktree,
        root: repo,
    });
});

test('outside a repository there is no common dir', async () => {
    /* When */
    const common = await git.commonDir(tmp);

    /* Then */
    assert.equal(common, null);
});

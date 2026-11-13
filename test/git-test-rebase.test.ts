/**
 * The test rebase (#435) against real git: a temporary repository stands in
 * for GitHub, and a bare clone of it is made and fetched into the way the
 * lane runner does it. `git replay` is used where the installed git has it,
 * `git merge-tree` otherwise; both must answer the same.
 */
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GitTestRebase} from '../src/infrastructure/git/git-test-rebase';
import {LocalGitRunner} from '../src/infrastructure/git/git-runner';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-test-rebase-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

const origin = path.join(work, 'origin');
const clones = path.join(work, 'clones');

function git(...args: string[]): string {
    return execFileSync('git', ['-C', origin, ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
        },
    });
}

function commit(file: string, text: string, message: string): void {
    fs.writeFileSync(path.join(origin, file), text);
    git('add', file);
    git('commit', '--quiet', '-m', message);
}

/** main with a shared file; `clean` touches another file, `conflicting` the same line main changed since. */
function makeOrigin(): void {
    fs.mkdirSync(origin, {recursive: true});
    git('init', '--quiet', '--initial-branch=main');
    commit('shared.txt', 'one\ntwo\nthree\n', 'Start');
    git('checkout', '--quiet', '-b', 'clean');
    commit('other.txt', 'mine\n', 'Add another file');
    git('checkout', '--quiet', 'main');
    git('checkout', '--quiet', '-b', 'conflicting');
    commit('shared.txt', 'one\nTWO by the branch\nthree\n', 'Change two');
    git('checkout', '--quiet', 'main');
    commit('shared.txt', 'one\nTWO by main\nthree\n', 'Change two on main');
}

makeOrigin();

const rebase = new GitTestRebase({
    git: new LocalGitRunner(),
    directory: clones,
    originUrl: () => origin,
});

test('a branch that rebases cleanly onto the trunk does not conflict', async () => {
    /* When */
    const answer = await rebase.conflicts('movelab/connect', 'main', 'clean');

    /* Then */
    assert.deepEqual(answer, {conflict: false, files: []});
});

test('a branch that changed the same lines as the trunk conflicts, naming the file', async () => {
    /* When */
    const answer = await rebase.conflicts('movelab/connect', 'main', 'conflicting');

    /* Then */
    assert.deepEqual(answer, {conflict: true, files: ['shared.txt']});
});

test('the test rebase leaves the repository and its branches as they were, and keeps one bare clone', async () => {
    /* Given */
    const before = git('for-each-ref', '--format=%(refname) %(objectname)');

    /* When */
    await rebase.conflicts('movelab/connect', 'main', 'conflicting');
    await rebase.conflicts('movelab/connect', 'main', 'clean');

    /* Then */
    assert.equal(git('for-each-ref', '--format=%(refname) %(objectname)'), before);
    assert.deepEqual(fs.readdirSync(path.join(clones, 'movelab')), ['connect.git']);
    assert.equal(fs.existsSync(path.join(clones, 'movelab', 'connect.git', 'HEAD')), true);
});

test('a branch that does not exist, or a name that is not a branch, cannot be tried', async () => {
    /* When */
    const missing = await rebase.conflicts('movelab/connect', 'main', 'nope');
    const option = await rebase.conflicts('movelab/connect', 'main', '--upload-pack=x');
    const range = await rebase.conflicts('movelab/connect', 'main', 'main..clean');

    /* Then */
    assert.equal(missing, null);
    assert.equal(option, null);
    assert.equal(range, null);
});

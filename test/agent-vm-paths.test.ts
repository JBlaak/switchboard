import {test} from 'node:test';
import assert from 'node:assert/strict';

import {isVmFolder, splitVmFolder, splitVmPath, vmFolder, vmPath} from '../src/domain/agent/vm-paths';

/** A VM's folders and transcript folders, named so the Mac's services can pass them along. */

const HOST = {user: 'dev', host: 'vm.local', port: 22};

test('an absolute VM path survives the round trip through its ssh name', () => {
    /* Given */
    const name = vmPath(HOST, '/home/dev/projects/site/.claude/worktrees/wt1');

    /* When */
    const back = splitVmPath(name);

    /* Then */
    assert.equal(name, 'ssh://dev@vm.local//home/dev/projects/site/.claude/worktrees/wt1');
    assert.deepEqual(back, {host: HOST, path: '/home/dev/projects/site/.claude/worktrees/wt1'});
});

test('a ~ path keeps its ~, a port other than 22 is named, and a local path is not a VM path', () => {
    /* Given */
    const name = vmPath({...HOST, port: 2222}, '~/projects/site');

    /* When */
    const back = splitVmPath(name);
    const local = splitVmPath('/Users/me/site');

    /* Then */
    assert.equal(name, 'ssh://dev@vm.local:2222/~/projects/site');
    assert.deepEqual(back, {host: {...HOST, port: 2222}, path: '~/projects/site'});
    assert.equal(local, null);
});

test('a VM transcript folder names its host and encoded folder', () => {
    /* Given */
    const folder = vmFolder(HOST, '-home-dev-projects-site');

    /* When */
    const back = splitVmFolder(folder);

    /* Then */
    assert.equal(folder, 'vm:dev@vm.local:22:-home-dev-projects-site');
    assert.deepEqual(back, {host: HOST, encoded: '-home-dev-projects-site'});
    assert.equal(isVmFolder(folder), true);
    assert.equal(isVmFolder('-Users-me-site'), false);
});

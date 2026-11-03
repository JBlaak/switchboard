import {test} from 'node:test';
import assert from 'node:assert/strict';

import {locateVmSession, type VmSessionLocationDeps} from '../src/application/services/vm-session-location';
import {vmFolder} from '../src/domain/agent/vm-paths';
import {encodeProjectPath} from '../src/domain/project/project-path';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

const HOST = {user: 'dev', host: 'vm.local', port: 2222};
const PROJECT = 'ssh://dev@vm.local:2222/~/projects/site';
const CWD = '/home/dev/projects/site';
const AGENT = {version: '2.12.0', installedAt: '2026-11-01T00:00:00Z'};

function deps(overrides: Partial<VmSessionLocationDeps> = {}): VmSessionLocationDeps {
    return {live: () => null, remoteProjects: () => [], vmCwd: () => null, ...overrides};
}

function remote(overrides: Partial<RemoteProjectSetting> = {}): RemoteProjectSetting {
    return {...HOST, dir: '~/projects/site', agent: AGENT, sessions: [], ...overrides};
}

test('a running VM session is located in the VM folder its cwd encodes to', () => {
    /* Given */
    const world = deps({live: () => ({projectPath: PROJECT, onAgent: true}), vmCwd: () => CWD});

    /* When */
    const located = locateVmSession(world, 's1');

    /* Then */
    assert.deepEqual(located, {folder: vmFolder(HOST, encodeProjectPath(CWD)), projectPath: PROJECT});
});

test('a VM session that is not running is found by its record on an agent host', () => {
    /* Given */
    const world = deps({
        remoteProjects: () => [remote({sessions: [{sessionId: 's1', kind: 'claude', created: ''}]})],
        vmCwd: () => CWD,
    });

    /* When */
    const located = locateVmSession(world, 's1');

    /* Then */
    assert.deepEqual(located, {folder: vmFolder(HOST, '-home-dev-projects-site'), projectPath: PROJECT});
});

test('before its transcript is fetched, an absolute project folder stands in; a ~ one leaves the folder unknown', () => {
    /* Given */
    const absolute = deps({
        remoteProjects: () => [remote({dir: CWD, sessions: [{sessionId: 's1', kind: 'claude', created: ''}]})],
    });
    const home = deps({live: () => ({projectPath: PROJECT, onAgent: true})});

    /* When */
    const fromDir = locateVmSession(absolute, 's1');
    const unknown = locateVmSession(home, 's1');

    /* Then */
    assert.equal(fromDir?.folder, vmFolder(HOST, encodeProjectPath(CWD)));
    assert.deepEqual(unknown, {folder: null, projectPath: PROJECT});
});

test('a local session, or one on an agentless remote, is not a VM session', () => {
    /* Given */
    const local = deps({live: () => ({projectPath: '/Users/me/dev/web', onAgent: false})});
    const agentless = deps({
        live: () => ({projectPath: PROJECT, onAgent: false}),
        remoteProjects: () => [remote({agent: undefined, sessions: [{sessionId: 's1', kind: 'claude', created: ''}]})],
        vmCwd: () => CWD,
    });

    /* When */
    const answers = [locateVmSession(local, 's1'), locateVmSession(agentless, 's1')];

    /* Then */
    assert.deepEqual(answers, [null, null]);
});

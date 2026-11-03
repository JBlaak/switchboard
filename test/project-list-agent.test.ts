/**
 * A remote whose host has a Switchboard agent (#276) is a VM project: the
 * project list marks it `agent`, and leaves an agentless remote as it was.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildProjectList} from '../src/domain/project/project-list';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

function build(remoteProjects: RemoteProjectSetting[]) {
    return buildProjectList({
        cached: [],
        meta: new Map(),
        hiddenProjects: new Set(),
        knownProjectPaths: ['/local'],
        activeTerminals: [],
        remoteProjects,
        pinnedPlans: [],
        pinnedIssuePlans: [],
        showArchived: false,
    });
}

test('a remote with an agent installed is a VM project', () => {
    /* Given */
    const remote: RemoteProjectSetting = {
        user: 'me',
        host: 'vm',
        port: 22,
        dir: 'app',
        agent: {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'},
    };

    /* When */
    const projects = build([remote]);

    /* Then */
    const project = projects.find((p) => p.projectPath === 'ssh://me@vm/app');
    assert.equal(project?.remote, true);
    assert.equal(project?.agent, true);
});

test('a remote without an agent stays an ssh project', () => {
    /* Given */
    const remote: RemoteProjectSetting = {user: 'me', host: 'box', port: 2222, dir: null};

    /* When */
    const projects = build([remote]);

    /* Then */
    const project = projects.find((p) => p.projectPath === 'ssh://me@box:2222');
    assert.equal(project?.remote, true);
    assert.equal(project?.agent, undefined);
});

test('a local project is never a VM project', () => {
    /* When */
    const projects = build([]);

    /* Then */
    assert.equal(projects.find((p) => p.projectPath === '/local')?.agent, undefined);
});

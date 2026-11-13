/** Sessions a VM's agent started by itself become rows on the Mac (#438, #442). */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SelfStartedCatchUp, selfStartedProjectDir} from '../src/application/services/self-started-catch-up';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';
import {silentLog} from './support/fakes';

const HOST = {user: 'dev', host: 'devbox', port: 22};

function setup(remotes: RemoteProjectSetting[] = []) {
    const touched: string[] = [];
    let changed = 0;
    const catchUp = new SelfStartedCatchUp({
        settings: {
            remoteProjects: () => remotes,
            addRemoteProject: (remote) => {
                remotes.push(remote);
                return true;
            },
            touchRemoteSession: (projectPath, sessionId) => {
                touched.push(`${projectPath} ${sessionId}`);
                return {sessionId, kind: 'claude', created: ''};
            },
        },
        renderer: {projectsChanged: () => void changed++},
        appVersion: '2.18.0',
        log: silentLog,
    });
    return {catchUp, touched, remotes, changed: () => changed};
}

test("an errand's session is the copy's: its worktree is under the copy, in ~ form", () => {
    /* Then */
    assert.equal(
        selfStartedProjectDir('/home/dev/projects/connect/.claude/worktrees/errand-7-abc', '/home/dev'),
        '~/projects/connect',
    );
    assert.equal(selfStartedProjectDir('/srv/connect', '/home/dev'), '/srv/connect');
});

test('each session the agent started by itself gets a row on its copy, made when missing, and is forgotten there', async () => {
    /* Given */
    const {catchUp, touched, remotes, changed} = setup();
    const forgotten: string[][] = [];

    /* When */
    await catchUp.catchUp({
        host: HOST,
        home: '/home/dev',
        agentVersion: '2.18.0',
        listSelfStarted: async () => [
            {sessionId: 's1', cwd: '/home/dev/projects/connect/.claude/worktrees/errand-7', startedAt: 1, errand: true},
        ],
        forgetSelfStarted: async (ids) => {
            forgotten.push(ids);
            return {ok: true};
        },
    });

    /* Then */
    assert.deepEqual(touched, ['ssh://dev@devbox/~/projects/connect s1']);
    assert.equal(remotes.length, 1);
    assert.deepEqual(forgotten, [['s1']]);
    assert.equal(changed(), 1);
});

test('an agent at another version is not asked', async () => {
    /* Given */
    const {catchUp} = setup();
    let asked = false;

    /* When */
    await catchUp.catchUp({
        host: HOST,
        home: '/home/dev',
        agentVersion: '2.17.8',
        listSelfStarted: async () => {
            asked = true;
            return [];
        },
        forgetSelfStarted: async () => ({ok: true}),
    });

    /* Then */
    assert.equal(asked, false);
});

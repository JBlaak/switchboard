import {test} from 'node:test';
import assert from 'node:assert/strict';

import {startMapLauncherWith, type MapLauncherSteps} from '../src/renderer/ui/session-work/plan/start-map-launcher';
import type {SessionOptions} from '../src/domain/launch/session-options';

const PROJECT = '/dev/connect-android';
const MAP = {repository: 'MoveLab-Studio/MoveLab-Connect-Android', number: 2241};

function steps(launch?: MapLauncherSteps['launch']): MapLauncherSteps & {launched: unknown[]} {
    const launched: unknown[] = [];
    return {
        launched,
        defaultOptions: async () => ({worktree: true, model: 'opus'}) as unknown as SessionOptions,
        launch:
            launch ??
            (async (projectPath, options, how) => {
                launched.push({projectPath, options, how});
                return {ok: true, sessionId: 'session-1'};
            }),
    };
}

test("a map launcher starts one session in the project with its skill, on the project's own options", async () => {
    /* Given */
    const fake = steps();

    /* When */
    const result = await startMapLauncherWith(fake, {
        projectPath: PROJECT,
        plan: MAP,
        launcher: 'reconcile',
        show: false,
    });

    /* Then */
    assert.deepEqual(result, {ok: true, sessionId: 'session-1'});
    assert.deepEqual(fake.launched, [
        {
            projectPath: PROJECT,
            options: {worktree: true, model: 'opus', initialPrompt: '/reconciling-the-map 2241'},
            how: {show: false},
        },
    ]);
});

test('a map launcher that cannot start answers why', async () => {
    /* Given */
    const fake = steps(async () => {
        throw new Error('claude is not installed');
    });

    /* When */
    const result = await startMapLauncherWith(fake, {projectPath: PROJECT, plan: MAP, launcher: 'next'});

    /* Then */
    assert.deepEqual(result, {ok: false, reason: 'claude is not installed'});
});

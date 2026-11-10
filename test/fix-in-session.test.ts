/**
 * Fix in session from a session header's merge queue panel (#315): main
 * hands it to the PR's own session, or the renderer starts an errand session.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixInSessionWith, type FixInSessionSteps} from '../src/renderer/ui/queue-elsewhere/fix-in-session';
import {sessionQueueFailure} from '../src/domain/project/queue-elsewhere';
import {failed, head, prUrl, queueOf, REPO} from './support/merge-queue-fixtures';
import type {FixRequest, FixResult} from '../src/domain/project/queue-errands';
import type {SessionOptions} from '../src/domain/launch/session-options';

const FAILURE = sessionQueueFailure([{number: 4, url: prUrl(4), repository: REPO}], {
    [REPO]: queueOf([head(1), failed(4)]),
})!;

function steps(answer: FixResult, launched: {ok: true; sessionId: string} | {ok: false; reason: string}) {
    const calls: string[] = [];
    const requests: FixRequest[] = [];
    const launches: Array<[string, SessionOptions]> = [];
    const fake: FixInSessionSteps = {
        fix: async (request) => {
            requests.push(request);
            return answer;
        },
        defaultOptions: async () => ({model: 'opus', worktree: true, worktreeName: 'x'}) as SessionOptions,
        launch: async (path, options) => {
            launches.push([path, options]);
            return launched;
        },
        started: async (errandId, sessionId) => {
            calls.push(`started ${errandId} ${sessionId}`);
            return {ok: true};
        },
        abandoned: async (errandId) => {
            calls.push(`abandoned ${errandId}`);
            return {ok: true};
        },
    };
    return {fake, calls, requests, launches};
}

test('the errand’s session starts in its worktree, off screen, with the queue’s failure, and is reported', async () => {
    /* Given */
    const {fake, calls, requests, launches} = steps(
        {ok: true, kind: 'start', errandId: 'e1', worktreePath: '/wt/fix-4', branch: 'branch-4', prompt: 'Fix it'},
        {ok: true, sessionId: 's9'},
    );

    /* When */
    const outcome = await fixInSessionWith(fake, {projectPath: '/code/app', failure: FAILURE});

    /* Then */
    assert.deepEqual(requests, [
        {
            repository: REPO,
            projectPath: '/code/app',
            pr: {number: 4, title: 'PR 4', url: prUrl(4), headRef: 'branch-4'},
            failure: {kind: 'ci', reason: 'CI failed: Unit tests', checkName: 'Unit tests'},
        },
    ]);
    assert.deepEqual(launches, [['/wt/fix-4', {model: 'opus', initialPrompt: 'Fix it'}]]);
    assert.deepEqual(calls, ['started e1 s9']);
    assert.equal(outcome.ok, true);
});

test('an errand session that would not start abandons the errand; a refusal is said as main said it', async () => {
    /* Given */
    const start = steps(
        {ok: true, kind: 'start', errandId: 'e1', worktreePath: '/wt/fix-4', branch: 'branch-4', prompt: 'Fix it'},
        {ok: false, reason: 'spawn failed'},
    );
    const refused = steps({ok: false, reason: 'A fix session for #4 is already running'}, {ok: true, sessionId: 'x'});

    /* When */
    const notStarted = await fixInSessionWith(start.fake, {projectPath: '/p', failure: FAILURE});
    const notAsked = await fixInSessionWith(refused.fake, {projectPath: '/p', failure: FAILURE});

    /* Then */
    assert.deepEqual(start.calls, ['abandoned e1']);
    assert.deepEqual(notStarted, {ok: false, text: 'spawn failed'});
    assert.deepEqual(notAsked, {ok: false, text: 'A fix session for #4 is already running'});
});

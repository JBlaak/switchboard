import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {HookRelay} from '../src/application/services/agent-client/hook-relay';
import {fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';
import type {QuestionReply} from '../src/application/services/question-service';
import type {AskedQuestions, Question} from '../src/domain/questions/question';

/**
 * A VM session's hooks reach the Mac's question service and archive tool, and
 * their answers go back over the link.
 */

const QUESTION: Question = {
    question: 'Which one?',
    header: 'Pick',
    options: [{label: 'A', description: ''}],
    multiSelect: false,
};

const ASKED: AskedQuestions = {toolUseId: 'tu1', questions: [QUESTION], toolInput: {questions: []}};

async function harness() {
    const agent = scriptedAgent();
    const connection = new AgentConnection({
        host: {user: 'joris', host: 'vm.local', port: 22},
        dialer: agent.dialer,
        appVersion: '2.12.0',
        timers: fakeTimers(),
        clock: {now: () => 0},
        log: silentLog,
    });

    const calls: unknown[][] = [];
    const replies: QuestionReply[] = [];
    let withdrawn = 0;
    const relay = new HookRelay(connection, {
        questions: {
            receive: (launchId, asked, reply) => {
                calls.push(['receive', launchId, asked]);
                replies.push(reply);
                return {withdraw: () => void withdrawn++};
            },
            receiveRound: (launchId, questions) => void calls.push(['receiveRound', launchId, questions]),
            promptSubmitted: (launchId) => void calls.push(['promptSubmitted', launchId]),
        },
        archiveTool: {
            request: (launchId) => {
                calls.push(['request', launchId]);
                return {ok: true, message: 'will archive'};
            },
            turnEnded: (launchId) => void calls.push(['turnEnded', launchId]),
        },
    });
    await connection.whenConnected();
    return {agent, connection, relay, calls, replies, withdrawn: () => withdrawn};
}

test('an ask reaches the question service and its answer goes back as ask-reply', async () => {
    /* Given */
    const h = await harness();
    h.agent.send({type: 'ask', hookId: 'h1', launchId: 's1', asked: ASKED});

    /* When */
    h.replies[0]({hookSpecificOutput: {permissionDecision: 'allow'}});

    /* Then */
    assert.deepEqual(h.calls, [['receive', 's1', ASKED]]);
    assert.deepEqual(h.agent.sent('ask-reply'), [
        {type: 'ask-reply', hookId: 'h1', json: {hookSpecificOutput: {permissionDecision: 'allow'}}},
    ]);
    assert.equal(h.relay.heldCount, 0);
});

test('an ask the agent withdraws is withdrawn on the Mac', async () => {
    /* Given */
    const h = await harness();
    h.agent.send({type: 'ask', hookId: 'h1', launchId: 's1', asked: ASKED});

    /* When */
    h.agent.send({type: 'ask-withdrawn', hookId: 'h1'});

    /* Then */
    assert.equal(h.withdrawn(), 1);
    assert.equal(h.relay.heldCount, 0);
});

test('a dropped link withdraws every held ask', async () => {
    /* Given */
    const h = await harness();
    h.agent.send({type: 'ask', hookId: 'h1', launchId: 's1', asked: ASKED});
    h.agent.send({type: 'ask', hookId: 'h2', launchId: 's2', asked: ASKED});

    /* When */
    h.agent.current().drop();
    await settle();

    /* Then */
    assert.equal(h.withdrawn(), 2);
    assert.equal(h.relay.heldCount, 0);
});

test('a grill round and a submitted prompt reach the question service', async () => {
    /* Given */
    const h = await harness();

    /* When */
    h.agent.send({type: 'grill-round', launchId: 's1', questions: [QUESTION]});
    h.agent.send({type: 'prompt-submitted', launchId: 's1'});

    /* Then */
    assert.deepEqual(h.calls, [
        ['receiveRound', 's1', [QUESTION]],
        ['promptSubmitted', 's1'],
    ]);
});

test("an archive request is answered with the archive tool's outcome, and the turn's end reaches it", async () => {
    /* Given */
    const h = await harness();

    /* When */
    h.agent.send({type: 'archive-request', hookId: 'a1', launchId: 's1'});
    h.agent.send({type: 'turn-ended', launchId: 's1'});

    /* Then */
    assert.deepEqual(h.agent.sent('archive-reply'), [
        {type: 'archive-reply', hookId: 'a1', outcome: {ok: true, message: 'will archive'}},
    ]);
    assert.deepEqual(h.calls, [
        ['request', 's1'],
        ['turnEnded', 's1'],
    ]);
});

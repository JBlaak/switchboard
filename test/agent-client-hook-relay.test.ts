import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {HookRelay} from '../src/application/services/agent-client/hook-relay';
import {fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';
import type {AskedQuestions, Question} from '../src/domain/questions/question';

type QuestionReply = (json: Record<string, unknown>) => void;

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
        hooks: {
            receive: (launchId, asked, reply) => {
                calls.push(['receive', launchId, asked]);
                replies.push(reply);
                return {withdraw: () => void withdrawn++};
            },
            turnEnded: (launchId, turn, agents) => void calls.push(['turnEnded', launchId, turn, agents]),
            promptSubmitted: (launchId, prompt) => void calls.push(['promptSubmitted', launchId, prompt]),
            subagentChanged: (launchId, event, agentId) =>
                void calls.push(['subagentChanged', launchId, event, agentId]),
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

test('an ended turn, a submitted prompt and subagent changes reach the hook receiver', async () => {
    /* Given */
    const h = await harness();
    const turn = {texts: [{id: 'u1', text: 'The round.'}]};

    /* When */
    h.agent.send({type: 'grill-turn', launchId: 's1', turn, backgroundAgents: ['ag1']});
    h.agent.send({type: 'grill-turn', launchId: 's1', turn: {texts: []}, backgroundAgents: null});
    h.agent.send({type: 'prompt-submitted', launchId: 's1', prompt: 'Q1: yes'});
    h.agent.send({type: 'subagent', launchId: 's1', event: 'start', agentId: 'ag1'});
    h.agent.send({type: 'subagent', launchId: 's1', event: 'stop', agentId: 'ag1'});

    /* Then */
    assert.deepEqual(h.calls, [
        ['turnEnded', 's1', turn, ['ag1']],
        ['turnEnded', 's1', {texts: []}, null],
        ['promptSubmitted', 's1', 'Q1: yes'],
        ['subagentChanged', 's1', 'start', 'ag1'],
        ['subagentChanged', 's1', 'stop', 'ag1'],
    ]);
});

test("an older agent's prompt notice without its text reads as an empty prompt, and its grill round is ignored", async () => {
    /* Given */
    const h = await harness();

    /* When */
    h.agent.send({type: 'prompt-submitted', launchId: 's1'});
    h.agent.send({type: 'grill-round', launchId: 's1', questions: [QUESTION]} as never);

    /* Then */
    assert.deepEqual(h.calls, [['promptSubmitted', 's1', '']]);
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

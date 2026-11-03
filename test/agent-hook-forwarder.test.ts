import {test} from 'node:test';
import assert from 'node:assert/strict';

import {HookForwarder} from '../src/application/services/agent-host/hook-forwarder';
import {ArchiveToolService} from '../src/application/services/archive-tool-service';
import {QuestionService} from '../src/application/services/question-service';
import {SessionRegistry} from '../src/application/model/session-registry';
import type {QuestionHookEndpoint} from '../src/application/ports/question-hook';
import type {AgentMessage} from '../src/domain/agent/protocol';
import type {AskedQuestions} from '../src/domain/questions/question';
import {QUESTION_HOOK_TOKEN_HEADER} from '../src/domain/questions/question';
import {QuestionHookServer} from '../src/infrastructure/http/question-hook-server';
import {linkPair, type LinkPair} from './support/agent-link';
import {fakeRenderer, fakeTimers, silentLog, type FakeTimers} from './support/fakes';

/**
 * The agent's hook forwarder, driven through an in-memory link: what the CLI
 * posts to the agent's hook server goes to the Mac end as messages, and the
 * Mac's answers come back to the CLI's reply.
 */

const asked: AskedQuestions = {
    toolUseId: 'tu-1',
    questions: [{question: 'Which database?', header: 'DB', options: [], multiSelect: false}],
    toolInput: {questions: []},
};

interface Harness {
    forwarder: HookForwarder;
    timers: FakeTimers;
    endpoint: {url: string | null; token: string};
    /** Connect a client the way the agent's router does: handshake done, replies routed, close reported. */
    connect(): Client;
}

interface Client {
    pair: LinkPair;
    /** What the Mac end received. */
    received: AgentMessage[];
}

function harness(): Harness {
    const timers = fakeTimers();
    let next = 0;
    const endpoint = {url: 'http://127.0.0.1:4100' as string | null, token: 'tok'};
    const forwarder = new HookForwarder({
        endpoint,
        timers,
        ids: {newId: () => `hook-${++next}`},
        log: silentLog,
    });
    return {
        forwarder,
        timers,
        endpoint,
        connect() {
            const pair = linkPair();
            const received: AgentMessage[] = [];
            pair.mac.onMessage((message) => received.push(message));
            pair.agent.onMessage((message) => {
                if (message.type === 'ask-reply' || message.type === 'archive-reply')
                    forwarder.handle(pair.agent, message);
            });
            pair.agent.onClose(() => forwarder.clientGone(pair.agent));
            forwarder.clientConnected(pair.agent);
            return {pair, received};
        },
    };
}

/** What the CLI's held request was answered with, if it was. */
function cliReply() {
    const replies: Record<string, unknown>[] = [];
    return {replies, reply: (json: Record<string, unknown>) => void replies.push(json)};
}

test('an ask goes to the Mac and its answer goes back to the CLI', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const cli = cliReply();

    /* When */
    h.forwarder.receiver.receive('launch-1', asked, cli.reply);
    const heldBeforeAnswer = cli.replies.length;
    mac.pair.mac.send({type: 'ask-reply', hookId: 'hook-1', json: {decision: 'answered'}});

    /* Then */
    assert.deepEqual(mac.received, [{type: 'ask', hookId: 'hook-1', launchId: 'launch-1', asked}]);
    assert.equal(heldBeforeAnswer, 0);
    assert.deepEqual(cli.replies, [{decision: 'answered'}]);
});

test('with no client connected an ask is released at once with no decision', () => {
    /* Given */
    const h = harness();
    const cli = cliReply();

    /* When */
    h.forwarder.receiver.receive('launch-1', asked, cli.reply);

    /* Then */
    assert.deepEqual(cli.replies, [{}]);
});

test('a client going away releases its held asks with no decision', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const cli = cliReply();
    h.forwarder.receiver.receive('launch-1', asked, cli.reply);

    /* When */
    mac.pair.drop();

    /* Then */
    assert.deepEqual(cli.replies, [{}]);
});

test('the CLI giving up withdraws the ask on the Mac, and a late answer is dropped', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const cli = cliReply();
    const handle = h.forwarder.receiver.receive('launch-1', asked, cli.reply);

    /* When */
    handle.withdraw();
    handle.withdraw();
    mac.pair.mac.send({type: 'ask-reply', hookId: 'hook-1', json: {late: true}});

    /* Then */
    assert.deepEqual(
        mac.received.map((m) => m.type),
        ['ask', 'ask-withdrawn'],
    );
    assert.deepEqual(mac.received[1], {type: 'ask-withdrawn', hookId: 'hook-1'});
    assert.deepEqual(cli.replies, []);
});

test('asks go to the newest client, and an older one going away keeps what the newer holds', () => {
    /* Given */
    const h = harness();
    const older = h.connect();
    const newer = h.connect();
    const cli = cliReply();

    /* When */
    h.forwarder.receiver.receive('launch-1', asked, cli.reply);
    older.pair.drop();
    older.pair.mac.send({type: 'ask-reply', hookId: 'hook-1', json: {fromOlder: true}});

    /* Then */
    assert.deepEqual(older.received, []);
    assert.equal(newer.received[0]?.type, 'ask');
    assert.deepEqual(cli.replies, []);

    /* When */
    newer.pair.mac.send({type: 'ask-reply', hookId: 'hook-1', json: {fromNewer: true}});

    /* Then */
    assert.deepEqual(cli.replies, [{fromNewer: true}]);
});

test('a reply from a client the ask was not sent to is ignored', () => {
    /* Given */
    const h = harness();
    const older = h.connect();
    const cli = cliReply();
    h.forwarder.receiver.receive('launch-1', asked, cli.reply);
    const newer = h.connect();

    /* When */
    newer.pair.mac.send({type: 'ask-reply', hookId: 'hook-1', json: {fromNewer: true}});

    /* Then */
    assert.deepEqual(cli.replies, []);
    assert.equal(older.received[0]?.type, 'ask');
});

test('grill rounds, prompt submits and turn ends are forwarded as notices', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();

    /* When */
    h.forwarder.receiver.receiveRound('launch-1', asked.questions);
    h.forwarder.receiver.promptSubmitted('launch-1');
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(mac.received, [
        {type: 'grill-round', launchId: 'launch-1', questions: asked.questions},
        {type: 'prompt-submitted', launchId: 'launch-1'},
        {type: 'turn-ended', launchId: 'launch-1'},
    ]);
});

test('notices with no client connected are dropped quietly', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    mac.pair.drop();

    /* When */
    h.forwarder.receiver.promptSubmitted('launch-1');
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(mac.received, []);
});

test("an archive call is answered with the Mac's outcome", async () => {
    /* Given */
    const h = harness();
    const mac = h.connect();

    /* When */
    const outcome = h.forwarder.archiveTool.request('launch-1');
    mac.pair.mac.send({type: 'archive-reply', hookId: 'hook-1', outcome: {ok: true, message: 'queued'}});

    /* Then */
    assert.deepEqual(mac.received, [{type: 'archive-request', hookId: 'hook-1', launchId: 'launch-1'}]);
    assert.deepEqual(await outcome, {ok: true, message: 'queued'});
    assert.equal(h.timers.pending, 0);
});

test('an archive call with no client says the Mac is not connected', async () => {
    /* Given */
    const h = harness();

    /* When */
    const outcome = await h.forwarder.archiveTool.request('launch-1');

    /* Then */
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /isn't connected/);
});

test('an archive call the Mac never answers times out as not archived', async () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const outcome = h.forwarder.archiveTool.request('launch-1');

    /* When */
    h.timers.tick();
    mac.pair.mac.send({type: 'archive-reply', hookId: 'hook-1', outcome: {ok: true, message: 'too late'}});

    /* Then */
    const settled = await outcome;
    assert.equal(settled.ok, false);
    assert.match(settled.message, /didn't answer in time/);
});

test('an archive call is answered as not archived when its client goes away', async () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const outcome = h.forwarder.archiveTool.request('launch-1');

    /* When */
    mac.pair.drop();

    /* Then */
    const settled = await outcome;
    assert.equal(settled.ok, false);
    assert.match(settled.message, /closed before it answered/);
    assert.equal(h.timers.pending, 0);
});

test("settings and tools point at the agent's own server, as a local launch's do at the Mac's", () => {
    /* Given */
    const h = harness();
    const endpoint: QuestionHookEndpoint = h.endpoint;
    const registry = new SessionRegistry();
    const questions = new QuestionService({
        registry,
        renderer: fakeRenderer(),
        endpoint,
        log: silentLog,
        clock: {now: () => 0},
        prompter: {send: () => {}, onExit: () => ({dispose() {}})},
    });
    const archive = new ArchiveToolService({
        registry,
        endpoint,
        log: silentLog,
        archiver: {archive: () => ({ok: true})},
    });

    /* When */
    const settings = h.forwarder.settingsFor('launch/1');
    const tools = h.forwarder.toolsFor('launch/1');

    /* Then */
    assert.equal(settings, questions.settingsFor('launch/1'));
    assert.deepEqual(tools, archive.launchFor('launch/1'));
    assert.match(settings ?? '', /http:\/\/127\.0\.0\.1:4100\/ask\/launch%2F1/);
});

test('settings and tools are null while the server is not listening', () => {
    /* Given */
    const h = harness();
    h.endpoint.url = null;

    /* When */
    const settings = h.forwarder.settingsFor('launch-1');
    const tools = h.forwarder.toolsFor('launch-1');

    /* Then */
    assert.equal(settings, null);
    assert.equal(tools, null);
});

test("over real sockets, the agent's hook server waits for the Mac's archive and ask answers", async (t) => {
    /* Given */
    let next = 0;
    const endpoint: QuestionHookEndpoint = {
        get url() {
            return server.url;
        },
        get token() {
            return server.token;
        },
    };
    const forwarder = new HookForwarder({
        endpoint,
        timers: fakeTimers(),
        ids: {newId: () => `hook-${++next}`},
        log: silentLog,
    });
    const server = new QuestionHookServer({
        receiver: forwarder.receiver,
        archiveTool: forwarder.archiveTool,
        log: silentLog,
    });
    await server.start();
    t.after(() => server.stop());
    const pair = linkPair();
    pair.agent.onMessage((message) => {
        if (message.type === 'ask-reply' || message.type === 'archive-reply') forwarder.handle(pair.agent, message);
    });
    forwarder.clientConnected(pair.agent);
    // The Mac end answers what it is sent, as the Mac's services would.
    pair.mac.onMessage((message) => {
        if (message.type === 'archive-request')
            setImmediate(() =>
                pair.mac.send({
                    type: 'archive-reply',
                    hookId: message.hookId,
                    outcome: {ok: true, message: 'archived later'},
                }),
            );
        if (message.type === 'ask')
            setImmediate(() => pair.mac.send({type: 'ask-reply', hookId: message.hookId, json: {answered: 1}}));
    });
    const post = (path: string, body: unknown) =>
        fetch(`${server.url}${path}`, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: {'Content-Type': 'application/json', [QUESTION_HOOK_TOKEN_HEADER]: server.token},
        });

    /* When */
    const called = await post('/mcp/launch-1', {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {name: 'archive_session', arguments: {}},
    });
    const listed = await post('/mcp/launch-1', {jsonrpc: '2.0', id: 8, method: 'tools/list'});
    const answered = await post('/ask/launch-1', {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-1',
        tool_input: {
            questions: [
                {
                    question: 'Which?',
                    header: 'Q',
                    options: [
                        {label: 'A', description: ''},
                        {label: 'B', description: ''},
                    ],
                    multiSelect: false,
                },
            ],
        },
    });

    /* Then */
    assert.deepEqual(await called.json(), {
        jsonrpc: '2.0',
        id: 7,
        result: {content: [{type: 'text', text: 'archived later'}], isError: false},
    });
    assert.equal(((await listed.json()) as {result: {tools: unknown[]}}).result.tools.length, 1);
    assert.deepEqual(await answered.json(), {answered: 1});
    assert.deepEqual(
        pair.sentByAgent.map((m) => ('type' in m ? m.type : 'output')),
        ['archive-request', 'ask'],
    );
});

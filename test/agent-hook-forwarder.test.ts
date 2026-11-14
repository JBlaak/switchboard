import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {HookForwarder} from '../src/application/services/agent-host/hook-forwarder';
import {ArchiveToolService} from '../src/application/services/archive-tool-service';
import {QuestionService} from '../src/application/services/question-service';
import {PAGE_TOOL_QUALIFIED_NAME} from '../src/domain/session/page-tool';
import {SessionRegistry} from '../src/application/model/session-registry';
import type {ActiveSession} from '../src/application/model/active-session';
import {NodeSelfArchivedFile} from '../src/infrastructure/agent/node-self-archived-file';
import type {QuestionHookEndpoint} from '../src/application/ports/question-hook';
import type {AgentMessage} from '../src/domain/agent/protocol';
import type {AskedQuestions} from '../src/domain/questions/question';
import {QUESTION_HOOK_TOKEN_HEADER} from '../src/domain/questions/question';
import {QuestionHookServer} from '../src/infrastructure/http/question-hook-server';
import {SELF_ARCHIVE_OUTCOME, type SelfArchivedFile} from '../src/application/services/agent-host/hook-forwarder';
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
    /** The sessions the forwarder stopped, by launch id. */
    stopped: string[];
    /** The self-archive record's text, as the VM's file would hold it. */
    file: MemoryFile;
    endpoint: {url: string | null; token: string};
    /** Connect a client the way the agent's router does: handshake done, replies routed, close reported. */
    connect(): Client;
}

interface Client {
    pair: LinkPair;
    /** What the Mac end received. */
    received: AgentMessage[];
}

/** The self-archive record in memory, shared by forwarders made over it (an agent restart). */
interface MemoryFile extends SelfArchivedFile {
    text: string | null;
}

function memoryFile(text: string | null = null): MemoryFile {
    const file: MemoryFile = {
        text,
        read: () => file.text,
        write: (next) => void (file.text = next),
    };
    return file;
}

function harness({file = memoryFile(), now = 1_000}: {file?: MemoryFile; now?: number} = {}): Harness {
    const timers = fakeTimers();
    let next = 0;
    const stopped: string[] = [];
    const endpoint = {url: 'http://127.0.0.1:4100' as string | null, token: 'tok'};
    const forwarder = new HookForwarder({
        endpoint,
        timers,
        ids: {newId: () => `hook-${++next}`},
        log: silentLog,
        stop: (launchId) => void stopped.push(launchId),
        selfArchived: file,
        clock: {now: () => now},
    });
    return {
        forwarder,
        timers,
        stopped,
        file,
        endpoint,
        connect() {
            const pair = linkPair();
            const received: AgentMessage[] = [];
            pair.mac.onMessage((message) => received.push(message));
            pair.agent.onMessage((message) => {
                if (
                    message.type === 'ask-reply' ||
                    message.type === 'archive-reply' ||
                    message.type === 'list-self-archived' ||
                    message.type === 'forget-self-archived'
                )
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

test('ended turns, prompt submits, subagent changes and turn ends are forwarded as notices', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const turn = {texts: [{id: 'u1', text: 'The round.'}]};

    /* When */
    h.forwarder.receiver.turnEnded('launch-1', turn, ['ag1']);
    h.forwarder.receiver.promptSubmitted('launch-1', 'Q1: yes');
    h.forwarder.receiver.subagentChanged('launch-1', 'start', 'ag1');
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(mac.received, [
        {type: 'grill-turn', launchId: 'launch-1', turn, backgroundAgents: ['ag1']},
        {type: 'prompt-submitted', launchId: 'launch-1', prompt: 'Q1: yes'},
        {type: 'subagent', launchId: 'launch-1', event: 'start', agentId: 'ag1'},
        {type: 'turn-ended', launchId: 'launch-1'},
    ]);
});

test('notices with no client connected are dropped quietly', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    mac.pair.drop();

    /* When */
    h.forwarder.receiver.promptSubmitted('launch-1', 'hi');
    h.forwarder.receiver.subagentChanged('launch-1', 'stop', 'ag1');
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

test('an archive call the Mac never answers is taken on by the agent', async () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const outcome = h.forwarder.archiveTool.request('launch-1');

    /* When */
    h.timers.tick();
    mac.pair.mac.send({type: 'archive-reply', hookId: 'hook-1', outcome: {ok: true, message: 'too late'}});

    /* Then */
    assert.deepEqual(await outcome, SELF_ARCHIVE_OUTCOME);
});

test('an archive call whose client goes away before answering is taken on by the agent', async () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const outcome = h.forwarder.archiveTool.request('launch-1');

    /* When */
    mac.pair.drop();

    /* Then */
    assert.deepEqual(await outcome, SELF_ARCHIVE_OUTCOME);
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
    // The same hooks, but without the 1Password heads-up: only the Mac has its pop-up.
    const localSettings = JSON.parse(questions.settingsFor('launch/1')!);
    localSettings.hooks.PreToolUse = localSettings.hooks.PreToolUse.filter(
        (entry: {matcher: string}) => entry.matcher !== 'Bash',
    );
    assert.deepEqual(JSON.parse(settings!), localSettings);
    // The same server, but without `show_page`: the agent does not forward its calls to the Mac yet.
    const local = archive.launchFor('launch/1');
    assert.deepEqual(tools, {
        mcpConfig: local?.mcpConfig,
        allowedTools: local?.allowedTools.filter((name) => name !== PAGE_TOOL_QUALIFIED_NAME),
    });
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
        stop: () => {},
        selfArchived: memoryFile(),
        clock: {now: () => 0},
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

// ── Archiving while the Mac is away (#308) ──

test('with no client, an archive call is accepted, and on turn end the session is stopped and recorded', async () => {
    /* Given */
    const h = harness({now: 1_700_000_000_000});

    /* When */
    const outcome = await h.forwarder.archiveTool.request('launch-1');
    const stoppedBeforeTurnEnd = [...h.stopped];
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(outcome, {ok: true, message: 'This session will be archived when this turn ends.'});
    assert.deepEqual(stoppedBeforeTurnEnd, []);
    assert.deepEqual(h.stopped, ['launch-1']);
    assert.deepEqual(JSON.parse(h.file.text ?? 'null'), [{sessionId: 'launch-1', archivedAt: 1_700_000_000_000}]);
});

test('a turn end with no self-archive pending stops nothing and records nothing', () => {
    /* Given */
    const h = harness();

    /* When */
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(h.stopped, []);
    assert.equal(h.file.text, null);
});

test('with a client, an archive call and its turn end go to the Mac as before, and nothing is stopped here', async () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const outcome = h.forwarder.archiveTool.request('launch-1');
    mac.pair.mac.send({type: 'archive-reply', hookId: 'hook-1', outcome: {ok: true, message: 'queued'}});
    await outcome;

    /* When */
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(mac.received, [
        {type: 'archive-request', hookId: 'hook-1', launchId: 'launch-1'},
        {type: 'turn-ended', launchId: 'launch-1'},
    ]);
    assert.deepEqual(h.stopped, []);
    assert.equal(h.file.text, null);
});

test('a client that arrives before the turn end is handed the missed archive call, then the turn end', async () => {
    /* Given */
    const h = harness();
    await h.forwarder.archiveTool.request('launch-1');
    const mac = h.connect();

    /* When */
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(mac.received, [
        {type: 'archive-request', hookId: 'hook-1', launchId: 'launch-1'},
        {type: 'turn-ended', launchId: 'launch-1'},
    ]);
    assert.deepEqual(h.stopped, []);
    assert.equal(h.file.text, null);
});

test('a client that arrives before the turn end lets the Mac archive it, through its own archive tool', async () => {
    /* Given */
    const h = harness();
    const archived: string[] = [];
    const registry = new SessionRegistry();
    registry.add('launch-1', {realSessionId: null} as unknown as ActiveSession);
    const tool = new ArchiveToolService({
        registry,
        endpoint: h.endpoint,
        log: silentLog,
        archiver: {archive: (id) => (archived.push(id), {ok: true})},
    });
    await h.forwarder.archiveTool.request('launch-1');
    const mac = h.connect();
    // The Mac's hook relay, as it answers a VM session's archive tool.
    mac.pair.mac.onMessage((message) => {
        if (message.type === 'archive-request')
            mac.pair.mac.send({type: 'archive-reply', hookId: message.hookId, outcome: tool.request(message.launchId)});
        if (message.type === 'turn-ended') tool.turnEnded(message.launchId);
    });

    /* When */
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(archived, ['launch-1']);
    assert.deepEqual(h.stopped, []);
});

test('the Mac lists the self-archived sessions, then forgets the ones it names', () => {
    /* Given */
    const h = harness({
        file: memoryFile(
            JSON.stringify([
                {sessionId: 's1', archivedAt: 1},
                {sessionId: 's2', archivedAt: 2},
                {sessionId: 's3', archivedAt: 3},
            ]),
        ),
    });
    const mac = h.connect();

    /* When */
    mac.pair.mac.send({type: 'list-self-archived', requestId: 'r1'});
    mac.pair.mac.send({type: 'forget-self-archived', requestId: 'r2', sessionIds: ['s1', 's3', 'never-there']});
    mac.pair.mac.send({type: 'list-self-archived', requestId: 'r3'});

    /* Then */
    assert.deepEqual(mac.received, [
        {
            type: 'self-archived',
            requestId: 'r1',
            sessions: [
                {sessionId: 's1', archivedAt: 1},
                {sessionId: 's2', archivedAt: 2},
                {sessionId: 's3', archivedAt: 3},
            ],
        },
        {type: 'done', requestId: 'r2', ok: true},
        {type: 'self-archived', requestId: 'r3', sessions: [{sessionId: 's2', archivedAt: 2}]},
    ]);
});

test('a missing or malformed record lists as empty', () => {
    /* Given */
    const missing = harness();
    const garbled = harness({file: memoryFile('{not json')});
    const missingMac = missing.connect();
    const garbledMac = garbled.connect();

    /* When */
    missingMac.pair.mac.send({type: 'list-self-archived', requestId: 'r1'});
    garbledMac.pair.mac.send({type: 'list-self-archived', requestId: 'r1'});

    /* Then */
    assert.deepEqual(missingMac.received, [{type: 'self-archived', requestId: 'r1', sessions: []}]);
    assert.deepEqual(garbledMac.received, [{type: 'self-archived', requestId: 'r1', sessions: []}]);
});

test('the record survives a new forwarder, as it does an agent restart', async () => {
    /* Given */
    const file = memoryFile();
    const before = harness({file, now: 42});
    await before.forwarder.archiveTool.request('launch-1');
    before.forwarder.archiveTool.turnEnded('launch-1');

    /* When */
    const after = harness({file});
    const mac = after.connect();
    mac.pair.mac.send({type: 'list-self-archived', requestId: 'r1'});

    /* Then */
    assert.deepEqual(mac.received, [
        {type: 'self-archived', requestId: 'r1', sessions: [{sessionId: 'launch-1', archivedAt: 42}]},
    ]);
});

test('the record on disk is mode 0600 and replaced whole', (t) => {
    /* Given */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-archived-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const file = new NodeSelfArchivedFile(path.join(dir, 'nested', 'self-archived.json'));
    const missing = file.read();

    /* When */
    file.write('[1]');
    file.write('[2]');

    /* Then */
    assert.equal(missing, null);
    assert.equal(file.read(), '[2]');
    assert.equal(fs.statSync(path.join(dir, 'nested', 'self-archived.json')).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'nested')), ['self-archived.json']);
});

// ── In-process listeners (#438) ──

test('with no client, an in-process listener still hears the archive call and the turn end', async () => {
    /* Given */
    const h = harness();
    const heard: string[] = [];
    h.forwarder.subscribe({
        turnEnded: (launchId) => void heard.push(`turn ${launchId}`),
        archiveRequested: (launchId) => void heard.push(`archive ${launchId}`),
    });

    /* When */
    await h.forwarder.archiveTool.request('errand-1');
    h.forwarder.archiveTool.turnEnded('errand-1');

    /* Then */
    assert.deepEqual(heard, ['archive errand-1', 'turn errand-1']);
    assert.deepEqual(h.stopped, ['errand-1']);
});

test('with a client, the listener hears the turn end and the Mac gets it too', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const heard: string[] = [];
    h.forwarder.subscribe({turnEnded: (launchId) => void heard.push(launchId)});

    /* When */
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(heard, ['launch-1']);
    assert.deepEqual(mac.received, [{type: 'turn-ended', launchId: 'launch-1'}]);
});

test('a listener that throws does not keep the others or the Mac from hearing', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const heard: string[] = [];
    h.forwarder.subscribe({
        turnEnded: () => {
            throw new Error('boom');
        },
    });
    h.forwarder.subscribe({turnEnded: (launchId) => void heard.push(launchId)});

    /* When */
    h.forwarder.archiveTool.turnEnded('launch-1');

    /* Then */
    assert.deepEqual(heard, ['launch-1']);
    assert.deepEqual(mac.received, [{type: 'turn-ended', launchId: 'launch-1'}]);
});

// ── Fix errands on a VM that merges (#442) ──

test('a question a listener takes never reaches the Mac, and the CLI is released to ask in its terminal', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();
    const cli = cliReply();
    const heard: string[] = [];
    h.forwarder.subscribe({
        asked: (launchId, question) => {
            heard.push(`${launchId}: ${question.questions[0].question}`);
            return true;
        },
    });

    /* When */
    h.forwarder.receiver.receive('errand-1', asked, cli.reply);

    /* Then */
    assert.deepEqual(heard, ['errand-1: Which database?']);
    assert.deepEqual(mac.received, []);
    assert.deepEqual(cli.replies, [{}]);
});

test('a finished errand is archived on the VM at its turn end even with a Mac connected', () => {
    /* Given */
    const h = harness();
    const mac = h.connect();

    /* When */
    h.forwarder.archiveAtTurnEnd('errand-1');
    h.forwarder.archiveTool.turnEnded('errand-1');

    /* Then */
    assert.deepEqual(h.stopped, ['errand-1']);
    assert.deepEqual(
        mac.received.map((message) => message.type),
        ['turn-ended'],
    );
    assert.match(String(h.file.text), /errand-1/);
});

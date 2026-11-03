import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentHost} from '../src/application/services/agent-host/agent-host';
import type {
    CopiesMessage,
    CopiesPart,
    TranscriptsMessage,
    TranscriptsPart,
    ToolsMessage,
    ToolsPart,
    HookForwarderMessage,
    HookForwarderPart,
    HostConfigMessage,
    HostConfigPart,
    SessionHostMessage,
    SessionHostPart,
} from '../src/application/services/agent-host/handlers';
import type {ClientLink} from '../src/application/ports/agent-link';
import type {Logger} from '../src/application/ports/logger';
import {AGENT_PROTOCOL_VERSION, type HostSettings, type MacMessage} from '../src/domain/agent/protocol';
import {parseMacMessage} from '../src/domain/agent/validate';
import {linkPair} from './support/agent-link';

/**
 * The agent's router: the handshake, turning away what it cannot read, and
 * handing every later message to the one part that owns it.
 */

const VERSION = '2.12.0';
const SETTINGS: HostSettings = {instructions: 'You are on a VM.', copyConfig: true, baseFolder: '~/projects'};
const HELLO: MacMessage = {type: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: VERSION};

/** Each call a fake part saw, as `part.method:type`. */
type Calls = string[];

function fakeParts(calls: Calls) {
    const aware = (name: string) => ({
        clientConnected: (_client: ClientLink) => void calls.push(`${name}.connected`),
        clientGone: (_client: ClientLink) => void calls.push(`${name}.gone`),
    });
    const sessions: SessionHostPart = {
        ...aware('sessions'),
        handle: (_client, message: SessionHostMessage) => void calls.push(`sessions.handle:${message.type}`),
        terminateAll: () => void calls.push('sessions.terminateAll'),
    };
    const hooks: HookForwarderPart = {
        ...aware('hooks'),
        handle: (_client, message: HookForwarderMessage) => void calls.push(`hooks.handle:${message.type}`),
        settingsFor: () => null,
        toolsFor: () => null,
    };
    const config: HostConfigPart = {
        ...aware('config'),
        handle: (_client, message: HostConfigMessage) => void calls.push(`config.handle:${message.type}`),
        current: () => SETTINGS,
    };
    const copies: CopiesPart = {
        ...aware('copies'),
        handle: (_client, message: CopiesMessage) => void calls.push(`copies.handle:${message.type}`),
    };
    const transcripts: TranscriptsPart = {
        ...aware('transcripts'),
        handle: (_client, message: TranscriptsMessage) => void calls.push(`transcripts.handle:${message.type}`),
    };
    const tools: ToolsPart = {
        ...aware('tools'),
        handle: (_client, message: ToolsMessage) => void calls.push(`tools.handle:${message.type}`),
    };
    return {sessions, hooks, config, copies, transcripts, tools};
}

const quietLog: Logger = {debug() {}, info() {}, warn() {}, error() {}};

function setUp() {
    const calls: Calls = [];
    const pair = linkPair();
    const host = new AgentHost({parts: fakeParts(calls), agentVersion: VERSION, log: quietLog});
    host.accept(pair.agent);
    return {calls, pair, host};
}

/** Sends something that is not a MacMessage, past the type checker, as a broken peer would. */
const sendRaw = (pair: ReturnType<typeof linkPair>, value: unknown) => pair.mac.send(value as MacMessage);

test('a matching hello is welcomed with the host settings and every part hears of the client', () => {
    /* Given */
    const {calls, pair} = setUp();

    /* When */
    pair.mac.send(HELLO);

    /* Then */
    assert.deepEqual(pair.sentByAgent, [
        {type: 'welcome', protocol: AGENT_PROTOCOL_VERSION, agentVersion: VERSION, settings: SETTINGS},
    ]);
    assert.deepEqual(calls, [
        'sessions.connected',
        'hooks.connected',
        'config.connected',
        'copies.connected',
        'transcripts.connected',
        'tools.connected',
    ]);
    assert.equal(pair.agent.closed, false);
});

test("the welcome names the VM user's home, so the Mac can resolve ~ paths", () => {
    /* Given */
    const pair = linkPair();
    new AgentHost({parts: fakeParts([]), agentVersion: VERSION, home: '/home/dev', log: quietLog}).accept(pair.agent);

    /* When */
    pair.mac.send(HELLO);

    /* Then */
    assert.equal((pair.sentByAgent[0] as {home?: string}).home, '/home/dev');
});

test('a hello from another app version on the same protocol is welcomed, naming the agent version', () => {
    /* Given */
    const {pair} = setUp();

    /* When */
    pair.mac.send({type: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: '2.13.0'});

    /* Then */
    const welcome = pair.sentByAgent[0] as {type: string; agentVersion: string};
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.agentVersion, VERSION);
    assert.equal(pair.agent.closed, false);
});

test('a hello on another protocol version gets bye version-mismatch', () => {
    /* Given */
    const {pair} = setUp();

    /* When */
    pair.mac.send({type: 'hello', protocol: AGENT_PROTOCOL_VERSION + 1, appVersion: VERSION});

    /* Then */
    assert.equal((pair.sentByAgent[0] as {code?: string}).code, 'version-mismatch');
    assert.equal(pair.agent.closed, true);
});

test('a message before hello gets bye protocol-error', () => {
    /* Given */
    const {calls, pair} = setUp();

    /* When */
    pair.mac.send({type: 'list-sessions', requestId: 'r1'});

    /* Then */
    assert.equal((pair.sentByAgent[0] as {code?: string}).code, 'protocol-error');
    assert.equal(pair.agent.closed, true);
    assert.deepEqual(calls, []);
});

for (const [what, value] of [
    ['a message without a type', {requestId: 'r1'}],
    ['a message that is not an object', ['hello']],
    ['a known type with a missing field', {type: 'input', sessionId: 's1'}],
] as const) {
    test(`after the handshake, ${what} gets bye protocol-error`, () => {
        /* Given */
        const {calls, pair} = setUp();
        pair.mac.send(HELLO);

        /* When */
        sendRaw(pair, value);

        /* Then */
        assert.equal((pair.sentByAgent.at(-1) as {code?: string}).code, 'protocol-error');
        assert.equal(pair.agent.closed, true);
        assert.equal(calls.filter((call) => call.includes('.handle')).length, 0);
    });
}

test('a second hello after the handshake is a protocol error', () => {
    /* Given */
    const {pair} = setUp();
    pair.mac.send(HELLO);

    /* When */
    pair.mac.send(HELLO);

    /* Then */
    assert.equal((pair.sentByAgent.at(-1) as {code?: string}).code, 'protocol-error');
    assert.equal(pair.agent.closed, true);
});

test('every message type goes to the part that owns it', () => {
    /* Given */
    const {calls, pair} = setUp();
    pair.mac.send(HELLO);
    calls.length = 0;
    const messages: MacMessage[] = [
        {type: 'open', requestId: 'r', sessionId: 's', kind: 'claude', dir: '~/p', isNew: true, cols: 80, rows: 24},
        {type: 'attach', sessionId: 's', since: -1, cols: 80, rows: 24},
        {type: 'input', sessionId: 's', data: 'ls\r'},
        {type: 'resize', sessionId: 's', cols: 100, rows: 30},
        {type: 'signal', sessionId: 's', signal: 'SIGINT'},
        {type: 'list-sessions', requestId: 'r'},
        {type: 'ask-reply', hookId: 'h', json: {}},
        {type: 'archive-reply', hookId: 'h', outcome: {ok: true, message: 'archived'}},
        {type: 'get-host-settings', requestId: 'r'},
        {type: 'set-host-settings', requestId: 'r', settings: {copyConfig: false}},
        {type: 'check-tools', requestId: 'r'},
        {
            type: 'copy-config',
            requestId: 'r',
            files: [{path: 'CLAUDE.md', contentBase64: '', mode: 0o644}],
            removed: [],
        },
    ];

    /* When */
    for (const message of messages) pair.mac.send(message);

    /* Then */
    assert.deepEqual(calls, [
        'sessions.handle:open',
        'sessions.handle:attach',
        'sessions.handle:input',
        'sessions.handle:resize',
        'sessions.handle:signal',
        'sessions.handle:list-sessions',
        'hooks.handle:ask-reply',
        'hooks.handle:archive-reply',
        'config.handle:get-host-settings',
        'config.handle:set-host-settings',
        'config.handle:check-tools',
        'config.handle:copy-config',
    ]);
    assert.equal(pair.agent.closed, false);
});

test('a dropped link tells every part the client is gone, once', () => {
    /* Given */
    const {calls, pair} = setUp();
    pair.mac.send(HELLO);
    calls.length = 0;

    /* When */
    pair.drop();
    pair.agent.close();

    /* Then */
    assert.deepEqual(calls, [
        'sessions.gone',
        'hooks.gone',
        'config.gone',
        'copies.gone',
        'transcripts.gone',
        'tools.gone',
    ]);
});

test('a client that never finished its handshake is not reported gone', () => {
    /* Given */
    const {calls, pair} = setUp();

    /* When */
    pair.drop();

    /* Then */
    assert.deepEqual(calls, []);
});

test('a bye from the client closes the link without an answer', () => {
    /* Given */
    const {calls, pair} = setUp();
    pair.mac.send(HELLO);
    calls.length = 0;

    /* When */
    pair.mac.send({type: 'bye', code: 'shutting-down'});

    /* Then */
    assert.equal(pair.sentByAgent.length, 1); // only the welcome
    assert.equal(pair.agent.closed, true);
    assert.deepEqual(calls, [
        'sessions.gone',
        'hooks.gone',
        'config.gone',
        'copies.gone',
        'transcripts.gone',
        'tools.gone',
    ]);
});

test('closeAll says bye shutting-down to every client', () => {
    /* Given */
    const {pair, host} = setUp();
    pair.mac.send(HELLO);

    /* When */
    host.closeAll();

    /* Then */
    assert.equal((pair.sentByAgent.at(-1) as {code?: string}).code, 'shutting-down');
    assert.equal(pair.agent.closed, true);
    assert.equal(host.clientCount, 0);
});

test('a part that throws is logged and the link stays up', () => {
    /* Given */
    const calls: Calls = [];
    const errors: string[] = [];
    const parts = fakeParts(calls);
    parts.sessions.handle = () => {
        throw new Error('boom');
    };
    const pair = linkPair();
    const log: Logger = {...quietLog, error: (message) => void errors.push(message)};
    new AgentHost({parts, agentVersion: VERSION, log}).accept(pair.agent);
    pair.mac.send(HELLO);

    /* When */
    pair.mac.send({type: 'list-sessions', requestId: 'r'});

    /* Then */
    assert.deepEqual(errors, ['agent: list-sessions failed']);
    assert.equal(pair.agent.closed, false);
});

test('the validator accepts an optional field added later and rejects a bad enum', () => {
    /* Given */
    const extended = {type: 'input', sessionId: 's', data: 'x', newField: 1};
    const badSignal = {type: 'signal', sessionId: 's', signal: 'SIGSEGV'};

    /* When */
    const results = [parseMacMessage(extended).ok, parseMacMessage(badSignal).ok];

    /* Then */
    assert.deepEqual(results, [true, false]);
});

test('a request this agent does not know is answered as refused, and the link stays up', () => {
    /* Given */
    const {pair} = setUp();
    pair.mac.send(HELLO);

    /* When */
    sendRaw(pair, {type: 'list-something-new', requestId: 'r9'});

    /* Then */
    assert.deepEqual(pair.sentByAgent.at(-1), {
        type: 'done',
        requestId: 'r9',
        ok: false,
        error: 'this agent does not know list-something-new; update the agent',
    });
    assert.equal(pair.agent.closed, false);
});

test('an unknown message before the handshake still closes the link', () => {
    /* Given */
    const {pair} = setUp();

    /* When */
    sendRaw(pair, {type: 'list-something-new', requestId: 'r9'});

    /* Then */
    assert.equal((pair.sentByAgent[0] as {code?: string}).code, 'protocol-error');
    assert.equal(pair.agent.closed, true);
});

test('an unknown notice without a request id is ignored, and the link stays up', () => {
    /* Given */
    const {pair} = setUp();
    pair.mac.send(HELLO);
    const before = pair.sentByAgent.length;

    /* When */
    sendRaw(pair, {type: 'launch-missiles'});

    /* Then */
    assert.equal(pair.sentByAgent.length, before);
    assert.equal(pair.agent.closed, false);
});

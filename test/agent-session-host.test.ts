import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionHost, expandHome, SHELL_COMMAND_DELAY_MS} from '../src/application/services/agent-host/session-host';
import {Scrollback, SCROLLBACK_MAX_BYTES} from '../src/application/services/agent-host/scrollback';
import {fakeTerminals, fakeTimers, resizingPty, silentLog} from './support/fakes';
import {linkPair} from './support/agent-link';
import type {FakePty} from './support/fakes';
import type {SessionHostMessage} from '../src/application/services/agent-host/handlers';
import type {AgentMessage, MacMessage, OpenSessionMessage, TerminalOutput} from '../src/domain/agent/protocol';

/**
 * The agent's session host: what it spawns for an `open`, how it numbers and
 * keeps output, what an `attach` replays, and which clients hear about what.
 * Driven through in-memory links whose agent end goes to the host, and checked
 * on what the Mac end received and what reached the fake PTYs.
 */

const HOME = '/home/me';
const SHELL = '/bin/bash';
const INSTRUCTIONS = "You're on a VM.";
const HOOKS = '{"hooks":"s1"}';
const MCP = '{"mcpServers":"s1"}';
const ARCHIVE_TOOL = 'mcp__switchboard__archive_session';

type Pty = FakePty & {readonly resizes: [number, number][]};

function harness({gitRepos = [`${HOME}/app`]}: {gitRepos?: string[]} = {}) {
    const terminals = fakeTerminals([1, 2, 3]);
    const timers = fakeTimers();
    const ptys: Pty[] = [];
    let nextPid = 1;
    const spawn = terminals.spawn.bind(terminals);
    terminals.spawn = (spec) => {
        const pty = resizingPty(nextPid++);
        ptys.push(pty);
        terminals.nextPty = pty;
        return spawn(spec);
    };

    const host = new SessionHost({
        terminals,
        loginShell: SHELL,
        hooks: {
            settingsFor: (id) => HOOKS.replace('s1', id),
            toolsFor: (id) => ({mcpConfig: MCP.replace('s1', id), allowedTools: [ARCHIVE_TOOL]}),
        },
        hostSettings: () => ({instructions: INSTRUCTIONS, copyConfig: true, baseFolder: '~/projects'}),
        git: {worktreeRoot: async (cwd) => (gitRepos.includes(cwd) ? cwd : null)},
        home: HOME,
        timers,
        log: silentLog,
    });

    /** A connected client: its Mac end's received messages and output. */
    function client() {
        const pair = linkPair();
        const messages: AgentMessage[] = [];
        const output: TerminalOutput[] = [];
        pair.agent.onMessage((m) => host.handle(pair.agent, m as SessionHostMessage));
        pair.mac.onMessage((m) => messages.push(m));
        pair.mac.onOutput((o) => output.push(o));
        host.clientConnected(pair.agent);
        return {
            pair,
            messages,
            output,
            /** Send and let the host's async open finish. */
            async send(message: MacMessage) {
                pair.mac.send(message);
                await settle();
            },
            gone() {
                pair.drop();
                host.clientGone(pair.agent);
            },
        };
    }

    return {host, terminals, timers, ptys, client};
}

async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
}

function open(fields: Partial<OpenSessionMessage> = {}): OpenSessionMessage {
    return {
        type: 'open',
        requestId: 'r1',
        sessionId: 's1',
        kind: 'claude',
        dir: '~/app',
        isNew: true,
        cols: 100,
        rows: 40,
        ...fields,
    };
}

// ── open: claude ──

test('a new claude session is spawned in the login shell with hooks, tools and host instructions', async () => {
    /* Given */
    const {terminals, client} = harness();
    const mac = client();

    /* When */
    await mac.send(
        open({options: {permissionMode: 'plan', appendSystemPrompt: 'Use pnpm.', initialPrompt: 'Fix the build'}}),
    );

    /* Then */
    assert.deepEqual(mac.messages, [{type: 'opened', requestId: 'r1', ok: true, reattached: false}]);
    assert.equal(terminals.spawns.length, 1);
    const spec = terminals.spawns[0];
    assert.equal(spec.file, SHELL);
    assert.deepEqual(spec.args, [
        '-l',
        '-i',
        '-c',
        'claude \'--settings\' \'{"hooks":"s1"}\' \'--mcp-config\' \'{"mcpServers":"s1"}\'' +
            ` '--allowedTools' '${ARCHIVE_TOOL}' '--session-id' 's1' '--permission-mode' 'plan'` +
            " '--append-system-prompt' 'Use pnpm.\n\nYou'\\''re on a VM.' '--' 'Fix the build'",
    ]);
    assert.equal(spec.cwd, `${HOME}/app`);
    assert.deepEqual([spec.cols, spec.rows], [100, 40]);
    assert.equal(spec.env.TERM_PROGRAM, 'iTerm.app');
    assert.equal(spec.env.CLAUDECODE, undefined);
});

test('a claude session with no options still gets the host instructions', async () => {
    /* Given */
    const {terminals, client} = harness();
    const mac = client();

    /* When */
    await mac.send(open());

    /* Then */
    const command = terminals.spawns[0].args[3];
    assert.match(command, /'--append-system-prompt' 'You'\\''re on a VM\.'$/);
});

test('a resumed claude session gets --resume and no starting prompt', async () => {
    /* Given */
    const {terminals, client} = harness();
    const mac = client();

    /* When */
    await mac.send(open({isNew: false, options: {initialPrompt: 'Fix the build', worktree: true}}));

    /* Then */
    const command = terminals.spawns[0].args[3];
    assert.match(command, /'--resume' 's1'/);
    assert.doesNotMatch(command, /--session-id|Fix the build|--worktree/);
});

test('--worktree is kept in a git repository and dropped outside one', async () => {
    /* Given */
    const {terminals, client} = harness({gitRepos: [`${HOME}/app`]});
    const mac = client();

    /* When */
    await mac.send(open({sessionId: 'in-repo', options: {worktree: true, worktreeName: 'fix'}}));
    await mac.send(open({sessionId: 'scratch', dir: '/tmp/scratch', options: {worktree: true, worktreeName: 'fix'}}));

    /* Then */
    assert.match(terminals.spawns[0].args[3], /'--worktree' 'fix'/);
    assert.doesNotMatch(terminals.spawns[1].args[3], /--worktree/);
    assert.equal(terminals.spawns[1].cwd, '/tmp/scratch');
});

test('an empty dir starts in the home folder', async () => {
    /* Given */
    const {terminals, client} = harness();
    const mac = client();

    /* When */
    await mac.send(open({dir: ''}));

    /* Then */
    assert.equal(terminals.spawns[0].cwd, HOME);
});

test('a launch option that cannot be made safe answers opened ok:false and spawns nothing', async () => {
    /* Given */
    const {terminals, client} = harness();
    const mac = client();

    /* When */
    await mac.send(open({options: {preLaunchCmd: 'aws-vault exec x --\nrm -rf /'}}));

    /* Then */
    assert.equal(terminals.spawns.length, 0);
    assert.deepEqual(mac.messages, [
        {type: 'opened', requestId: 'r1', ok: false, error: 'preLaunchCmd must not contain newlines'},
    ]);
});

// ── open: shell ──

test('a shell session is a login shell that types its command once it is up', async () => {
    /* Given */
    const {terminals, timers, ptys, client} = harness();
    const mac = client();

    /* When */
    await mac.send(open({kind: 'shell', command: 'bash ~/.switchboard/setup.sh'}));
    const before = [...ptys[0].writes];
    timers.tick();

    /* Then */
    const spec = terminals.spawns[0];
    assert.equal(spec.file, SHELL);
    assert.deepEqual(spec.args, ['-l', '-i']);
    // No `claude` shim on a VM: the setup script installs and runs the real one.
    assert.equal(spec.env.BASH_ENV, undefined);
    assert.equal(spec.env.CLAUDECODE, undefined);
    assert.deepEqual(before, []);
    assert.deepEqual(ptys[0].writes, ['bash ~/.switchboard/setup.sh\n']);
    assert.ok(SHELL_COMMAND_DELAY_MS > 0);
});

test('a shell session with no command types nothing', async () => {
    /* Given */
    const {timers, ptys, client} = harness();
    const mac = client();

    /* When */
    await mac.send(open({kind: 'shell'}));
    timers.tick();

    /* Then */
    assert.deepEqual(ptys[0].writes, []);
    assert.equal(timers.pending, 0);
});

// ── open: already alive ──

test('opening a session that is alive attaches to it and replays what it kept', async () => {
    /* Given */
    const {terminals, ptys, client} = harness();
    const first = client();
    await first.send(open());
    ptys[0].emitData('hello');
    const second = client();

    /* When */
    await second.send(open({requestId: 'r2', cols: 80, rows: 24}));

    /* Then */
    assert.equal(terminals.spawns.length, 1);
    assert.deepEqual(second.messages, [{type: 'opened', requestId: 'r2', ok: true, reattached: true}]);
    assert.deepEqual(second.output, [{sessionId: 's1', seq: 0, data: 'hello'}]);
    assert.deepEqual(ptys[0].resizes, [[80, 24]]);
});

test('two opens for the same session at once spawn it only once', async () => {
    /* Given */
    const {terminals, client} = harness();
    const mac = client();

    /* When */
    mac.pair.mac.send(open({requestId: 'a'}));
    mac.pair.mac.send(open({requestId: 'b'}));
    await settle();

    /* Then */
    assert.equal(terminals.spawns.length, 1);
    assert.deepEqual(mac.messages, [
        {type: 'opened', requestId: 'a', ok: true, reattached: false},
        {type: 'opened', requestId: 'b', ok: true, reattached: true},
    ]);
});

// ── Output and clients ──

test('output is numbered from 0 and goes to every client that opened or attached', async () => {
    /* Given */
    const {ptys, client} = harness();
    const opener = client();
    const attacher = client();
    const bystander = client();
    await opener.send(open());
    await attacher.send({type: 'attach', sessionId: 's1', since: -1, cols: 100, rows: 40});

    /* When */
    ptys[0].emitData('one');
    ptys[0].emitData('two');

    /* Then */
    const expected = [
        {sessionId: 's1', seq: 0, data: 'one'},
        {sessionId: 's1', seq: 1, data: 'two'},
    ];
    assert.deepEqual(opener.output, expected);
    assert.deepEqual(attacher.output, expected);
    assert.deepEqual(bystander.output, []);
});

test('a client that goes away stops getting output and the session keeps running', async () => {
    /* Given */
    const {terminals, ptys, client} = harness();
    const mac = client();
    await mac.send(open());
    mac.gone();

    /* When */
    ptys[0].emitData('while away');
    const back = client();
    await back.send({type: 'list-sessions', requestId: 'l'});

    /* Then */
    assert.deepEqual(mac.output, []);
    assert.deepEqual(terminals.signals, []);
    assert.deepEqual(back.messages, [
        {
            type: 'sessions',
            requestId: 'l',
            sessions: [{sessionId: 's1', kind: 'claude', cwd: `${HOME}/app`, alive: true, lastSeq: 0}],
        },
    ]);
});

test('exited goes to every client that had the session, and to no other', async () => {
    /* Given */
    const {ptys, client} = harness();
    const opener = client();
    const attacher = client();
    const bystander = client();
    await opener.send(open());
    await attacher.send({type: 'attach', sessionId: 's1', since: -1, cols: 100, rows: 40});

    /* When */
    ptys[0].emitExit(0);

    /* Then */
    const exited = {type: 'exited', sessionId: 's1', exitCode: 0};
    assert.deepEqual(opener.messages.at(-1), exited);
    assert.deepEqual(attacher.messages.at(-1), exited);
    assert.deepEqual(bystander.messages, []);
});

// ── attach ──

test('attach replays the chunks after since', async () => {
    /* Given */
    const {ptys, client} = harness();
    const opener = client();
    await opener.send(open());
    for (const data of ['a', 'b', 'c']) ptys[0].emitData(data);
    const back = client();

    /* When */
    await back.send({type: 'attach', sessionId: 's1', since: 0, cols: 90, rows: 30});

    /* Then */
    assert.deepEqual(back.messages, [{type: 'attached', sessionId: 's1', alive: true, reset: false}]);
    assert.deepEqual(back.output, [
        {sessionId: 's1', seq: 1, data: 'b'},
        {sessionId: 's1', seq: 2, data: 'c'},
    ]);
    assert.deepEqual(ptys[0].resizes, [[90, 30]]);
});

test('attach resets and replays from the oldest kept chunk when since + 1 was evicted', async () => {
    /* Given */
    const {ptys, client} = harness();
    const opener = client();
    await opener.send(open());
    const half = 'x'.repeat(SCROLLBACK_MAX_BYTES / 2);
    for (const data of [half, half, half]) ptys[0].emitData(data);
    const back = client();

    /* When */
    await back.send({type: 'attach', sessionId: 's1', since: -1, cols: 100, rows: 40});

    /* Then */
    assert.deepEqual(back.messages, [{type: 'attached', sessionId: 's1', alive: true, reset: true}]);
    assert.deepEqual(
        back.output.map((o) => o.seq),
        [1, 2],
    );
});

test('attach to an unknown session answers not alive, without a reset', async () => {
    /* Given */
    const {client} = harness();
    const mac = client();

    /* When */
    await mac.send({type: 'attach', sessionId: 'nope', since: 4, cols: 100, rows: 40});

    /* Then */
    assert.deepEqual(mac.messages, [{type: 'attached', sessionId: 'nope', alive: false, reset: false}]);
    assert.deepEqual(mac.output, []);
});

test('attach to a session that ended replays what it printed and answers not alive', async () => {
    /* Given */
    const {ptys, client} = harness();
    const opener = client();
    await opener.send(open());
    ptys[0].emitData('done');
    ptys[0].emitExit(1);
    const back = client();

    /* When */
    await back.send({type: 'attach', sessionId: 's1', since: -1, cols: 100, rows: 40});

    /* Then */
    assert.deepEqual(back.messages, [{type: 'attached', sessionId: 's1', alive: false, reset: false}]);
    assert.deepEqual(back.output, [{sessionId: 's1', seq: 0, data: 'done'}]);
});

// ── input, resize, signal ──

test('input and resize go to the PTY', async () => {
    /* Given */
    const {ptys, client} = harness();
    const mac = client();
    await mac.send(open());

    /* When */
    await mac.send({type: 'input', sessionId: 's1', data: 'y\r'});
    await mac.send({type: 'resize', sessionId: 's1', cols: 132, rows: 50});

    /* Then */
    assert.deepEqual(ptys[0].writes, ['y\r']);
    assert.deepEqual(ptys[0].resizes, [[132, 50]]);
});

test('signal signals the session process tree', async () => {
    /* Given */
    const {terminals, client} = harness();
    const mac = client();
    await mac.send(open());

    /* When */
    await mac.send({type: 'signal', sessionId: 's1', signal: 'SIGINT'});

    /* Then */
    assert.deepEqual(terminals.signals, [[1, 'SIGINT']]);
});

test('signal falls back to the process alone when the tree cannot be reached', async () => {
    /* Given */
    const {terminals, ptys, client} = harness();
    terminals.signalTree = () => false;
    const mac = client();
    await mac.send(open());

    /* When */
    await mac.send({type: 'signal', sessionId: 's1', signal: 'SIGTERM'});

    /* Then */
    assert.deepEqual(ptys[0].kills, ['SIGTERM']);
});

test('stop sends SIGTERM to a live session tree, for an archive made with no Mac (#308)', async () => {
    /* Given */
    const {host, terminals, ptys, client} = harness();
    const mac = client();
    await mac.send(open({sessionId: 'a'}));
    await mac.send(open({sessionId: 'b'}));
    ptys[1].emitExit(0);

    /* When */
    const stoppedLive = host.stop('a');
    const stoppedEnded = host.stop('b');
    const stoppedUnknown = host.stop('nope');

    /* Then */
    assert.deepEqual([stoppedLive, stoppedEnded, stoppedUnknown], [true, false, false]);
    assert.deepEqual(terminals.signals, [[1, 'SIGTERM']]);
});

// ── list-sessions and terminateAll ──

test('list-sessions answers every live and remembered ended session with its last seq', async () => {
    /* Given */
    const {ptys, client} = harness();
    const mac = client();
    await mac.send(open({sessionId: 'a'}));
    await mac.send(open({sessionId: 'b', kind: 'shell', dir: '/srv'}));
    ptys[0].emitData('x');
    ptys[1].emitExit(0);

    /* When */
    await mac.send({type: 'list-sessions', requestId: 'l'});

    /* Then */
    assert.deepEqual(mac.messages.at(-1), {
        type: 'sessions',
        requestId: 'l',
        sessions: [
            {sessionId: 'a', kind: 'claude', cwd: `${HOME}/app`, alive: true, lastSeq: 0},
            {sessionId: 'b', kind: 'shell', cwd: '/srv', alive: false, lastSeq: -1},
        ],
    });
});

test('terminateAll signals every live session and no ended one', async () => {
    /* Given */
    const {host, terminals, ptys, client} = harness();
    const mac = client();
    await mac.send(open({sessionId: 'a'}));
    await mac.send(open({sessionId: 'b'}));
    await mac.send(open({sessionId: 'c'}));
    ptys[1].emitExit(0);

    /* When */
    host.terminateAll();

    /* Then */
    assert.deepEqual(terminals.signals, [
        [1, 'SIGTERM'],
        [3, 'SIGTERM'],
    ]);
});

test('opening an ended session starts it again with its numbering from 0', async () => {
    /* Given */
    const {terminals, ptys, client} = harness();
    const mac = client();
    await mac.send(open());
    ptys[0].emitData('first run');
    ptys[0].emitExit(0);

    /* When */
    await mac.send(open({requestId: 'r2', isNew: false}));
    ptys[1].emitData('second run');

    /* Then */
    assert.equal(terminals.spawns.length, 2);
    assert.deepEqual(mac.messages.at(-1), {type: 'opened', requestId: 'r2', ok: true, reattached: false});
    assert.deepEqual(mac.output.at(-1), {sessionId: 's1', seq: 0, data: 'second run'});
});

// ── The pure parts ──

test('expandHome makes a leading ~ absolute and leaves other paths alone', () => {
    /* Given */
    const home = '/home/me';

    /* When */
    const expanded = ['', '~', '~/a/b', '/srv/x', '~other/x'].map((dir) => expandHome(dir, home));

    /* Then */
    assert.deepEqual(expanded, [home, home, '/home/me/a/b', '/srv/x', '~other/x']);
});

test('scrollback keeps the newest chunk even when it alone is over the bound', () => {
    /* Given */
    const scrollback = new Scrollback(4);

    /* When */
    scrollback.append('ab');
    scrollback.append('abcdef');

    /* Then */
    assert.equal(scrollback.lastSeq, 1);
    assert.deepEqual(scrollback.since(-1), {reset: true, chunks: [{seq: 1, data: 'abcdef'}]});
});

test('scrollback resets when since is past its last chunk', () => {
    /* Given */
    const scrollback = new Scrollback();
    scrollback.append('a');

    /* When */
    const replay = scrollback.since(7);

    /* Then */
    assert.deepEqual(replay, {reset: true, chunks: [{seq: 0, data: 'a'}]});
});

test('scrollback counts bytes, not characters', () => {
    /* Given */
    const scrollback = new Scrollback(4);

    /* When */
    scrollback.append('é');
    scrollback.append('éé');

    /* Then */
    assert.deepEqual(scrollback.since(-1).chunks, [{seq: 1, data: 'éé'}]);
});

test('scrollback with nothing missed replays nothing and does not reset', () => {
    /* Given */
    const scrollback = new Scrollback();
    scrollback.append('a');

    /* When */
    const replay = scrollback.since(0);

    /* Then */
    assert.deepEqual(replay, {reset: false, chunks: []});
});

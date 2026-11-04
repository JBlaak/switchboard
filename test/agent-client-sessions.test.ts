import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionRegistry} from '../src/application/model/session-registry';
import {AgentAwareTerminals} from '../src/application/services/agent-client/agent-aware-terminals';
import {AgentClient, TERMINAL_RESET} from '../src/application/services/agent-client/agent-client';
import {RemoteConnectionSupervisor} from '../src/application/services/remote-connection-supervisor';
import {SessionLauncher} from '../src/application/services/session-launcher';
import {SessionLifecycle} from '../src/application/services/session-lifecycle';
import {buildSshArgv, buildSshSpawn} from '../src/domain/remote/ssh-command';
import {reconnectSession} from '../src/main/reconnect-session';
import {stopSession} from '../src/main/stop-session';
import {fakeRenderer, fakeTerminals, fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';
import type {SessionLauncherDeps} from '../src/application/services/session-launcher';
import type {SessionOptions} from '../src/domain/launch/session-options';
import type {MacMessage} from '../src/domain/agent/protocol';

/**
 * A session on a VM host runs on its agent: the Mac's ActiveSession holds a
 * stand-in PTY, and everything the lifecycle does with it crosses the link.
 * A legacy remote, with no agent, still dials ssh+tmux.
 */

const PROJECT = 'ssh://joris@vm.local/proj';

function harness({agentHost = true}: {agentHost?: boolean} = {}) {
    const agent = scriptedAgent();
    const timers = fakeTimers();
    const clock = {now: () => 0};
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const local = fakeTerminals();
    const terminals = new AgentAwareTerminals(local);
    const remote = new RemoteConnectionSupervisor({
        registry,
        terminals,
        renderer,
        timers,
        clock,
        log: silentLog,
        homeDir: '/Users/joris',
    });
    const lifecycle = new SessionLifecycle({registry, terminals, renderer, remote, timers, log: silentLog});
    remote.attach(lifecycle);

    const client = new AgentClient({
        dialer: agent.dialer,
        appVersion: '2.12.0',
        registry,
        renderer,
        questions: {receive: () => ({withdraw() {}}), receiveRound() {}, promptSubmitted() {}},
        archiveTool: {request: () => ({ok: true, message: ''}), turnEnded() {}},
        timers,
        clock,
        log: silentLog,
    });

    const touched: [string, string, string][] = [];
    const project = () => ({
        user: 'joris',
        host: 'vm.local',
        port: 22,
        dir: 'proj',
        ...(agentHost ? {agent: {version: '2.12.0', installedAt: '2026-11-03T00:00:00Z'}} : {}),
    });
    const settings = {
        shellProfileId: () => null,
        findRemoteProject: project,
        ensureRemoteProject: project,
        touchRemoteSession: (projectPath: string, sessionId: string, kind: string) => {
            touched.push([projectPath, sessionId, kind]);
            return {id: sessionId, kind};
        },
    };

    const launcher = new SessionLauncher({
        registry,
        terminals,
        shells: {list: () => [], resolve: () => ({id: 'zsh', name: 'zsh', path: '/bin/zsh'})},
        transcripts: {listSessionIds: () => [], readSlug: () => null},
        settings,
        lifecycle,
        remote,
        renderer,
        questions: {settingsFor: () => null},
        git: {worktreeRoot: async () => null},
        clock,
        timers,
        log: silentLog,
        fileExists: () => true,
        agents: client,
    } as unknown as SessionLauncherDeps);

    const open = (sessionId = 's1', options?: SessionOptions, isNew = true) =>
        launcher.open({sessionId, projectPath: PROJECT, isNew, options});

    /** What the Mac sent to the agent of one type, without the handshake. */
    const sent = <T extends MacMessage['type']>(type: T) => agent.sent(type);

    return {agent, timers, registry, renderer, local, terminals, remote, lifecycle, client, touched, open, sent};
}

test('a launch on an agent host opens the session on the agent instead of spawning ssh', async () => {
    /* Given */
    const h = harness();

    /* When */
    const result = await h.open('s1', {permissionMode: 'plan', remoteKind: 'claude'});

    /* Then */
    assert.deepEqual(result, {ok: true, reattached: false});
    assert.deepEqual(h.sent('open'), [
        {
            type: 'open',
            requestId: 'r1',
            sessionId: 's1',
            kind: 'claude',
            dir: 'proj',
            isNew: true,
            options: {permissionMode: 'plan', remoteKind: 'claude'},
            cols: 120,
            rows: 30,
        },
    ]);
    assert.equal(h.local.spawns.length, 0, 'no local process');
    assert.ok(h.registry.get('s1'), 'registered as running');
    assert.equal(h.registry.get('s1')?.remote, null, 'not a tmux remote');
    assert.deepEqual(h.touched, [[PROJECT, 's1', 'claude']], 'the row persists');
});

test('a remote shell opens as a shell session', async () => {
    /* Given */
    const h = harness();

    /* When */
    await h.open('s1', {remoteKind: 'shell'});

    /* Then */
    assert.equal(h.sent('open')[0].kind, 'shell');
});

test("the agent's output reaches the renderer, and its OSC status drives busy detection", async () => {
    /* Given */
    const h = harness();
    await h.open('s1');

    /* When */
    h.agent.output('s1', 0, '\x1b]7501;state=working:app=claude-code\x1b\\Thinking…');

    /* Then */
    assert.deepEqual(h.renderer.only('terminalData').at(-1), [
        'terminalData',
        's1',
        '\x1b]7501;state=working:app=claude-code\x1b\\Thinking…',
    ]);
    assert.deepEqual(h.renderer.only('cliBusyState'), [['cliBusyState', 's1', true]]);
});

test('typing and resizing are forwarded to the agent', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    const session = h.registry.get('s1');

    /* When */
    session?.pty.write('ls\r');
    session?.pty.resize(100, 40);

    /* Then */
    assert.deepEqual(h.sent('input'), [{type: 'input', sessionId: 's1', data: 'ls\r'}]);
    assert.deepEqual(h.sent('resize'), [{type: 'resize', sessionId: 's1', cols: 100, rows: 40}]);
});

test("the agent's refusal is the launch's error, and nothing stays registered", async () => {
    /* Given */
    const h = harness();
    h.agent.answerOpen = (open) => ({type: 'opened', requestId: open.requestId, ok: false, error: 'no such directory'});

    /* When */
    const result = await h.open('s1');

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'no such directory'});
    assert.equal(h.registry.get('s1'), undefined);
});

test('a dropped link shows every session on the host retrying, and keeps them running', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    await h.open('s2');

    /* When */
    h.agent.current().drop('Connection reset by peer');

    /* Then */
    const retrying = h.renderer.only('remoteStatus').filter(([, , s]) => (s as {phase: string}).phase === 'retrying');
    assert.deepEqual(
        retrying.map(([, id]) => id),
        ['s1', 's2'],
    );
    assert.deepEqual(h.lifecycle.runningSessionIds(), ['s1', 's2']);
    assert.equal(h.renderer.only('processExited').length, 0);
});

test('after a relink each session reattaches from the last output it showed', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    h.agent.output('s1', 0, 'one');
    h.agent.output('s1', 1, 'two');
    h.registry.get('s1')?.pty.resize(100, 40);
    h.agent.current().drop();

    /* When */
    h.timers.tick();
    await settle();

    /* Then */
    assert.equal(h.agent.dials.length, 2);
    assert.deepEqual(h.agent.current().sentByMac.slice(1), [
        {type: 'attach', sessionId: 's1', since: 1, cols: 100, rows: 40},
    ]);
});

test('a replay that does not continue from the screen is preceded by a terminal reset', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    h.agent.output('s1', 0, 'old');
    h.agent.current().drop();
    h.timers.tick();
    await settle();

    /* When */
    h.agent.send({type: 'attached', sessionId: 's1', alive: true, reset: true});
    h.agent.output('s1', 40, 'replayed');

    /* Then */
    assert.deepEqual(
        h.renderer.only('terminalData').map(([, , data]) => data),
        ['old', TERMINAL_RESET, 'replayed'],
    );
});

test('output already shown is not shown again by an overlapping replay', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    h.agent.output('s1', 0, 'zero');
    h.agent.output('s1', 1, 'one');

    /* When */
    h.agent.output('s1', 1, 'one');
    h.agent.output('s1', 2, 'two');

    /* Then */
    assert.deepEqual(
        h.renderer.only('terminalData').map(([, , data]) => data),
        ['zero', 'one', 'two'],
    );
});

test('a session that ended while the Mac was away exits on reattach', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    h.agent.current().drop();
    h.timers.tick();
    await settle();

    /* When */
    h.agent.send({type: 'attached', sessionId: 's1', alive: false, reset: false});

    /* Then */
    assert.deepEqual(h.renderer.only('processExited'), [['processExited', 's1', 0]]);
    assert.equal(h.registry.get('s1'), undefined);
});

test("the agent's exited ends the session", async () => {
    /* Given */
    const h = harness();
    await h.open('s1');

    /* When */
    h.agent.send({type: 'exited', sessionId: 's1', exitCode: 3});

    /* Then */
    assert.deepEqual(h.renderer.only('processExited'), [['processExited', 's1', 3]]);
    assert.equal(h.registry.get('s1'), undefined);
});

test('stopping a VM session signals it on the agent, escalating as a local stop does', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');

    /* When */
    const result = stopSession(h, 's1');
    h.timers.tick();

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(h.sent('signal'), [
        {type: 'signal', sessionId: 's1', signal: 'SIGTERM'},
        {type: 'signal', sessionId: 's1', signal: 'SIGKILL'},
    ]);
    assert.deepEqual(h.local.signals, [], 'nothing local is signalled');
});

test('a stop made while the link is down reaches the agent once it is back', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    h.agent.current().drop();
    stopSession(h, 's1');

    /* When */
    h.timers.tick();
    await settle();

    /* Then */
    assert.deepEqual(
        h.agent.current().sentByMac.filter((m) => m.type === 'signal'),
        [{type: 'signal', sessionId: 's1', signal: 'SIGKILL'}],
    );
});

test('quitting the app closes the links and leaves VM sessions running', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');

    /* When */
    h.client.shutdown();
    h.lifecycle.terminateAll();

    /* Then */
    assert.deepEqual(h.sent('signal'), []);
    assert.equal(h.agent.current().mac.closed, true);
});

test("a renderer coming back to a VM session is told where its host's link stands", async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    const before = h.renderer.only('remoteStatus').length;

    /* When */
    await h.open('s1');

    /* Then */
    assert.deepEqual(h.renderer.only('remoteStatus').slice(before), [
        ['remoteStatus', 's1', {phase: 'connected', target: 'joris@vm.local'}],
    ]);
});

test('an agentless remote still spawns ssh+tmux exactly as before', async () => {
    /* Given */
    const h = harness({agentHost: false});

    /* When */
    const result = await h.open('s1', {remoteKind: 'claude'});

    /* Then */
    assert.deepEqual(result, {ok: true, reattached: false});
    const expected = buildSshSpawn(
        buildSshArgv({user: 'joris', host: 'vm.local', port: 22, dir: 'proj'}, 's1', 'claude'),
        '/bin/zsh',
    );
    assert.deepEqual(h.local.spawns, [
        {
            file: expected.file,
            args: expected.args,
            cols: 120,
            rows: 30,
            cwd: '/Users/joris',
            env: {TERM: 'xterm-256color', COLORTERM: 'truecolor'},
        },
    ]);
    assert.equal(h.agent.dials.length, 0, 'no agent dialled');
    assert.ok(h.registry.get('s1')?.remote, 'a tmux remote');
    assert.deepEqual(h.renderer.only('remoteStatus'), [
        ['remoteStatus', 's1', {phase: 'connecting', target: 'joris@vm.local:proj'}],
    ]);
});

test('opening a session on a host whose link gave up dials it again', async () => {
    /* Given */
    const h = harness();
    h.agent.failNextDial = 'joris@vm.local: Permission denied (publickey).';
    const first = await h.open('s1');

    /* When */
    const second = await h.open('s2');

    /* Then */
    assert.equal(first.ok, false);
    assert.match(first.error ?? '', /could not reach the agent on joris@vm.local: .*Permission denied/);
    assert.deepEqual(second, {ok: true, reattached: false});
    assert.equal(h.agent.dialledHosts.length, 2);
});

test('Retry now on a VM session whose host link gave up dials the host again, and the session comes back', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    h.agent.failNextDial = 'joris@vm.local: Permission denied (publickey).';
    h.agent.current().drop('Timeout, server vm.local not responding.');
    h.timers.tick();
    await settle();
    const gaveUp = h.renderer.only('remoteStatus').at(-1);
    assert.equal((gaveUp?.[2] as {phase: string}).phase, 'failed');
    const dialsBefore = h.agent.dialledHosts.length;

    /* When */
    const result = reconnectSession({...h, agents: h.client}, 's1');
    await settle();

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.equal(h.agent.dialledHosts.length, dialsBefore + 1);
    assert.deepEqual(h.renderer.only('remoteStatus').at(-1), [
        'remoteStatus',
        's1',
        {phase: 'connected', target: 'joris@vm.local'},
    ]);
    assert.deepEqual(h.lifecycle.runningSessionIds(), ['s1']);
});

test('Retry now on a VM session whose host link is up dials nothing', async () => {
    /* Given */
    const h = harness();
    await h.open('s1');
    const dialsBefore = h.agent.dialledHosts.length;

    /* When */
    const result = reconnectSession({...h, agents: h.client}, 's1');

    /* Then */
    assert.deepEqual(result, {ok: true, alreadyConnected: true});
    assert.equal(h.agent.dialledHosts.length, dialsBefore);
});

test('Retry now on a legacy remote session still goes to its ssh supervisor', async () => {
    /* Given */
    const h = harness({agentHost: false});
    await h.open('s1', {remoteKind: 'claude'});

    /* When */
    const result = reconnectSession({...h, agents: h.client}, 's1');

    /* Then */
    assert.deepEqual(result, {ok: true, alreadyConnected: true});
    assert.equal(h.agent.dials.length, 0, 'no agent dialled');
});

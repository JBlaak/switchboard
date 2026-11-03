import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentConnection} from '../src/application/services/agent-client/agent-connection';
import {AGENT_PROTOCOL_VERSION} from '../src/domain/agent/protocol';
import {MAX_RETRIES} from '../src/domain/remote/reconnect-policy';
import {fakeTimers, silentLog} from './support/fakes';
import {HOST_SETTINGS, scriptedAgent, settle} from './support/scripted-agent';
import type {RemoteStatusPayload} from '../src/domain/remote/remote-status';

/**
 * One host's link to its agent: the handshake, keeping it up, and asking it
 * things.
 */

const HOST = {user: 'joris', host: 'vm.local', port: 22};

function harness() {
    const agent = scriptedAgent();
    const timers = fakeTimers();
    let now = 0;
    const connection = new AgentConnection({
        host: HOST,
        dialer: agent.dialer,
        appVersion: '2.12.0',
        timers,
        clock: {now: () => now},
        log: silentLog,
        requestTimeoutMs: 5000,
    });
    const statuses: RemoteStatusPayload[] = [];
    connection.onStatus((s) => statuses.push(s));
    const phases = () => statuses.map((s) => s.phase);
    return {agent, timers, connection, statuses, phases, advance: (ms: number) => (now += ms)};
}

test('connecting says hello with the protocol and app version, and keeps the host settings from welcome', async () => {
    /* Given */
    const h = harness();

    /* When */
    await h.connection.whenConnected();

    /* Then */
    assert.deepEqual(h.agent.sent('hello'), [{type: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: '2.12.0'}]);
    assert.deepEqual(h.connection.settings, HOST_SETTINGS);
    assert.deepEqual(h.statuses, [
        {phase: 'connecting', target: 'joris@vm.local'},
        {phase: 'connected', target: 'joris@vm.local'},
    ]);
});

test('a dropped link shows retrying and redials after the backoff', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();

    /* When */
    h.agent.current().drop('Connection reset by peer');
    const afterDrop = h.statuses.at(-1);
    h.timers.tick();
    await settle();

    /* Then */
    assert.deepEqual(afterDrop, {
        phase: 'retrying',
        target: 'joris@vm.local',
        reason: 'Connection reset by peer',
        attempt: 1,
        maxAttempts: MAX_RETRIES,
        delayMs: 1000,
        everConnected: true,
    });
    assert.equal(h.agent.dials.length, 2);
    assert.equal(h.connection.connected, true);
    assert.deepEqual(h.phases().slice(-2), ['connecting', 'connected']);
});

test('every (re)connect runs the connected listeners', async () => {
    /* Given */
    const h = harness();
    let connects = 0;
    h.connection.onConnected(() => connects++);
    await h.connection.whenConnected();

    /* When */
    h.agent.current().drop();
    h.timers.tick();
    await settle();

    /* Then */
    assert.equal(connects, 2);
});

test('a host that never answers is given up on after the last attempt', async () => {
    /* Given */
    const h = harness();
    h.agent.failNextDial = 'ssh: connect to host vm.local port 22: Operation timed out';
    const connected = assert.rejects(h.connection.whenConnected(), /Operation timed out/);
    await settle();

    /* When */
    for (let i = 0; i < MAX_RETRIES; i++) {
        h.agent.failNextDial = 'ssh: connect to host vm.local port 22: Operation timed out';
        h.timers.tick();
        await settle();
    }

    /* Then */
    await connected;
    assert.equal(h.connection.state, 'failed');
    assert.equal(h.statuses.at(-1)?.phase, 'failed');
    assert.equal(h.timers.pending, 0, 'nothing more is scheduled');
});

test('a rejected login is not retried', async () => {
    /* Given */
    const h = harness();
    h.agent.failNextDial = 'joris@vm.local: Permission denied (publickey).';

    /* When */
    await assert.rejects(h.connection.whenConnected(), /Permission denied/);

    /* Then */
    assert.equal(h.connection.state, 'failed');
    assert.equal(h.timers.pending, 0);
    assert.equal(h.agent.dialledHosts.length, 1);
});

test('an agent of another version says bye, and the connection asks for a reinstall instead of redialling', async () => {
    /* Given */
    const h = harness();
    h.agent.greet = 'version-mismatch';
    const reinstall: string[] = [];
    h.connection.onNeedsReinstall((reason) => reinstall.push(reason));

    /* When */
    await assert.rejects(h.connection.whenConnected());
    h.timers.tick();
    await settle();

    /* Then */
    assert.deepEqual(reinstall, ['agent is 1.0.0']);
    assert.equal(h.connection.state, 'needs-reinstall');
    assert.equal(h.agent.dials.length, 1, 'no redial');
    assert.equal(h.statuses.at(-1)?.phase, 'failed');
});

test('a welcome at another protocol is a mismatch too, answered with bye', async () => {
    /* Given */
    const h = harness();
    h.agent.greet = 'old-protocol';
    let reinstalls = 0;
    h.connection.onNeedsReinstall(() => reinstalls++);

    /* When */
    await assert.rejects(h.connection.whenConnected());

    /* Then */
    assert.equal(reinstalls, 1);
    assert.deepEqual(h.agent.sent('bye'), [{type: 'bye', code: 'version-mismatch'}]);
    assert.equal(h.agent.dials.length, 1);
});

test('a host without the agent installed asks for a reinstall', async () => {
    /* Given */
    const h = harness();
    h.agent.failNextDial = 'bash: line 1: /home/joris/.switchboard/bin/switchboard-agent: No such file or directory';
    let reinstalls = 0;
    h.connection.onNeedsReinstall(() => reinstalls++);

    /* When */
    await assert.rejects(h.connection.whenConnected());

    /* Then */
    assert.equal(reinstalls, 1);
    assert.equal(h.connection.state, 'needs-reinstall');
});

test('retryNow after a reinstall dials again', async () => {
    /* Given */
    const h = harness();
    h.agent.greet = 'version-mismatch';
    await assert.rejects(h.connection.whenConnected());
    h.agent.greet = 'welcome';

    /* When */
    h.connection.retryNow();
    await settle();

    /* Then */
    assert.equal(h.connection.connected, true);
});

test('requests are matched to their answers by request id', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();
    h.agent.current().agent.onMessage((m) => {
        if (m.type === 'check-tools')
            h.agent.send({type: 'tools', requestId: m.requestId, tools: [{tool: 'git', installed: true}], sudo: true});
        if (m.type === 'get-host-settings')
            h.agent.send({
                type: 'host-settings',
                requestId: m.requestId,
                settings: {...HOST_SETTINGS, copyConfig: false},
            });
    });

    /* When */
    const [tools, settings] = await Promise.all([h.connection.checkTools(), h.connection.getHostSettings()]);

    /* Then */
    assert.deepEqual(tools, {tools: [{tool: 'git', installed: true}], sudo: true});
    assert.equal(settings.copyConfig, false);
    assert.equal(h.connection.settings?.copyConfig, false);
    const ids = h.agent.sentByMac().flatMap((m) => ('requestId' in m ? [m.requestId] : []));
    assert.equal(new Set(ids).size, 2);
});

test('a request the agent never answers times out', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();
    const listed = h.connection.listSessions();
    await settle();

    /* When */
    h.timers.tick();

    /* Then */
    await assert.rejects(listed, /did not answer within 5s/);
});

test('a request in flight when the link drops fails', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();
    const copied = h.connection.copyConfig([], []);
    await settle();

    /* When */
    h.agent.current().drop('Broken pipe');

    /* Then */
    await assert.rejects(copied, /dropped: Broken pipe/);
});

test('a link that stood for a while starts the backoff over', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();
    h.agent.current().drop();
    h.timers.tick();
    await settle();
    h.advance(60_000);

    /* When */
    h.agent.current().drop();

    /* Then */
    assert.equal(h.statuses.at(-1)?.attempt, 1);
});

test('close leaves the link down for good', async () => {
    /* Given */
    const h = harness();
    await h.connection.whenConnected();

    /* When */
    h.connection.close();
    h.timers.tick();
    await settle();

    /* Then */
    assert.equal(h.connection.state, 'closed');
    assert.equal(h.agent.current().mac.closed, true);
    assert.equal(h.agent.dials.length, 1);
});

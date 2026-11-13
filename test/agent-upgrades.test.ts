import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentUpgrades} from '../src/application/services/agent-upgrades';
import {silentLog} from './support/fakes';
import type {WelcomedAgent} from '../src/application/services/agent-upgrades';
import type {AgentSessionInfo} from '../src/domain/agent/protocol';

/**
 * Upgrading a VM's agent ends every session running there, so an app update
 * must not upgrade an agent that is busy; an agent on another protocol has to
 * be upgraded regardless, because nothing else can be said to it.
 */

const HOST = {user: 'dev', host: 'vm.local', port: 22};

function harness({projectOnHost = true}: {projectOnHost?: boolean} = {}) {
    const installs: string[] = [];
    const redials: string[] = [];
    const upgrades = new AgentUpgrades({
        appVersion: '2.13.0',
        agentProjectOn: () => (projectOnHost ? 'ssh://dev@vm.local/apps/site' : null),
        install: (projectPath) => {
            installs.push(projectPath);
            return Promise.resolve({ok: true});
        },
        redial: (host) => void redials.push(host.host),
        log: silentLog,
    });
    return {upgrades, installs, redials};
}

function agent(version: string, sessions: Partial<AgentSessionInfo>[] = []): WelcomedAgent {
    return {
        host: HOST,
        target: 'dev@vm.local',
        agentVersion: version,
        listSessions: () =>
            Promise.resolve(
                sessions.map((s, i) => ({
                    sessionId: `s${i}`,
                    kind: 'claude',
                    cwd: '/',
                    alive: false,
                    lastSeq: 0,
                    ...s,
                })),
            ),
    };
}

test('an older agent with nothing running is upgraded and dialled again', async () => {
    /* Given */
    const {upgrades, installs, redials} = harness();

    /* When */
    await upgrades.connected(agent('2.12.0', [{alive: false}]));

    /* Then */
    assert.deepEqual(installs, ['ssh://dev@vm.local/apps/site']);
    assert.deepEqual(redials, ['vm.local']);
});

test('an older agent with a live session is left running', async () => {
    /* Given */
    const {upgrades, installs} = harness();

    /* When */
    await upgrades.connected(agent('2.12.0', [{alive: true}]));

    /* Then */
    assert.deepEqual(installs, []);
});

test('an older agent running a fix errand is left running, though no Mac opened it', async () => {
    /* Given */
    const {upgrades, installs} = harness();

    /* When */
    await upgrades.connected(agent('2.12.0', [{alive: true, selfStarted: true, errand: true}]));

    /* Then */
    assert.deepEqual(installs, []);
});

test('an older agent whose fix errand has ended is upgraded', async () => {
    /* Given */
    const {upgrades, installs} = harness();

    /* When */
    await upgrades.connected(agent('2.12.0', [{alive: false, selfStarted: true, errand: true}]));

    /* Then */
    assert.deepEqual(installs, ['ssh://dev@vm.local/apps/site']);
});

test('an agent at the app version is left alone', async () => {
    /* Given */
    const {upgrades, installs} = harness();

    /* When */
    await upgrades.connected(agent('2.13.0'));

    /* Then */
    assert.deepEqual(installs, []);
});

test('another protocol is upgraded at once, busy or not, and only once while it runs', async () => {
    /* Given */
    const {upgrades, installs} = harness();

    /* When */
    await Promise.all([upgrades.protocolMismatch(HOST, 'protocol 2'), upgrades.protocolMismatch(HOST, 'protocol 2')]);

    /* Then */
    assert.deepEqual(installs, ['ssh://dev@vm.local/apps/site']);
});

test('a host with no agent project is not installed on', async () => {
    /* Given */
    const {upgrades, installs} = harness({projectOnHost: false});

    /* When */
    await upgrades.protocolMismatch(HOST, 'protocol 2');

    /* Then */
    assert.deepEqual(installs, []);
});

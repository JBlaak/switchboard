import {test} from 'node:test';
import assert from 'node:assert/strict';

import {AgentHostsService} from '../src/application/services/agent-hosts-service';
import {silentLog} from './support/fakes';
import type {AgentInstaller} from '../src/application/services/agent-hosts-service';
import type {OpenSessionRequest} from '../src/application/services/session-launcher';
import type {HostSettings} from '../src/domain/agent/protocol';

/**
 * The façade the UI's VM sections call (#276): status from the installer and
 * the link, questions through the host's connection, and the setup terminal
 * as a shell session that runs the setup script.
 */

const VM = 'ssh://dev@vm.local/apps/site';
const SETTINGS: HostSettings = {instructions: 'You are on a VM.', copyConfig: true, baseFolder: '~/projects'};

function harness({installed = '2.12.0', reachable = true}: {installed?: string | null; reachable?: boolean} = {}) {
    const opened: OpenSessionRequest[] = [];
    const retries: string[] = [];
    const connection = {
        connected: reachable,
        state: reachable ? 'connected' : 'failed',
        target: 'dev@vm.local',
        retryNow: () => void retries.push('retry'),
        whenConnected: () => (reachable ? Promise.resolve() : Promise.reject(new Error('Permission denied'))),
        checkTools: () =>
            Promise.resolve({tools: [{tool: 'git' as const, installed: true, version: '2.43'}], sudo: true}),
        getHostSettings: () => Promise.resolve(SETTINGS),
        setHostSettings: (partial: Partial<HostSettings>) => Promise.resolve({...SETTINGS, ...partial}),
    };
    const installer: AgentInstaller = {
        installedVersion: () => Promise.resolve(installed),
        install: () => Promise.resolve({ok: true}),
    };
    const service = new AgentHostsService({
        agents: {connection: () => connection as never, connectionFor: () => connection as never},
        installer,
        launcher: {
            open: (request) => {
                opened.push(request);
                return Promise.resolve({ok: true});
            },
        },
        setupCommand: 'sh ~/.switchboard/setup.sh',
        appVersion: '2.12.0',
        ids: {newId: () => 'setup-1'},
        log: silentLog,
    });
    return {service, opened, retries};
}

test('a host at the app version is current, and its open link counts as connected', async () => {
    /* Given */
    const {service} = harness();

    /* When */
    const status = await service.status(VM);

    /* Then */
    assert.deepEqual(status, {installed: '2.12.0', current: true, connected: true});
});

test('an older agent is not current', async () => {
    /* Given */
    const {service} = harness({installed: '2.11.9'});

    /* When */
    const status = await service.status(VM);

    /* Then */
    assert.equal(status.current, false);
});

test('host settings are read and saved through the link', async () => {
    /* Given */
    const {service} = harness();

    /* When */
    const read = await service.hostSettings(VM);
    const saved = await service.setHostSettings(VM, {copyConfig: false});

    /* Then */
    assert.deepEqual(read, SETTINGS);
    assert.equal(saved?.copyConfig, false);
});

test('a host that cannot be reached answers null rather than throwing', async () => {
    /* Given */
    const {service} = harness({reachable: false});

    /* When */
    const tools = await service.checkTools(VM);

    /* Then */
    assert.equal(tools, null);
});

test('the setup terminal is a new shell session on the host that runs the setup script', async () => {
    /* Given */
    const {service, opened} = harness();

    /* When */
    const result = await service.openSetupTerminal(VM);

    /* Then */
    assert.deepEqual(result, {ok: true, sessionId: 'setup-1'});
    assert.deepEqual(opened, [
        {
            sessionId: 'setup-1',
            projectPath: VM,
            isNew: true,
            options: {type: 'remote', remoteKind: 'shell', agentCommand: 'sh ~/.switchboard/setup.sh'},
        },
    ]);
});

test('a finished install makes the host link try again at once', async () => {
    /* Given */
    const {service, retries} = harness();

    /* When */
    await service.install(VM);

    /* Then */
    assert.deepEqual(retries, ['retry']);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionRegistry} from '../src/application/model/session-registry';
import {AgentClient} from '../src/application/services/agent-client/agent-client';
import {HookForwarder, type SelfArchivedFile} from '../src/application/services/agent-host/hook-forwarder';
import {SelfArchiveCatchUp} from '../src/application/services/self-archive-catch-up';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';

/**
 * The Mac catching up on the VM sessions that archived themselves while it
 * was away (#308): on every connect it lists the agent's record, archives the
 * rows it knows without stopping them again, and has the agent forget them.
 *
 * The scripted agent plays the host; its list and forget are answered by a
 * real HookForwarder over the record, so both halves meet over the framing.
 */

const HOST = {user: 'joris', host: 'vm.local', port: 22};
const APP_VERSION = '2.12.0';

function vmProject(sessionIds: string[], overrides: Partial<RemoteProjectSetting> = {}): RemoteProjectSetting {
    return {
        ...HOST,
        dir: 'proj',
        agent: {version: APP_VERSION, installedAt: '2026-11-03T00:00:00Z'},
        sessions: sessionIds.map((sessionId) => ({sessionId, kind: 'claude', created: ''})),
        ...overrides,
    } as RemoteProjectSetting;
}

function harness({
    record,
    projects,
    catchUpVersion = APP_VERSION,
}: {
    record: {sessionId: string; archivedAt: number}[];
    projects: RemoteProjectSetting[];
    catchUpVersion?: string;
}) {
    const agent = scriptedAgent();
    const file: SelfArchivedFile & {text: string | null} = {
        text: JSON.stringify(record),
        read: () => file.text,
        write: (text) => void (file.text = text),
    };
    const forwarder = new HookForwarder({
        endpoint: {url: null, token: ''},
        timers: fakeTimers(),
        ids: {newId: () => 'hook'},
        log: silentLog,
        stop: () => {},
        selfArchived: file,
        clock: {now: () => 0},
    });

    const client = new AgentClient({
        dialer: {
            async dial(host) {
                const link = await agent.dialer.dial(host);
                const pair = agent.current();
                pair.agent.onMessage((message) => {
                    if (message.type === 'list-self-archived' || message.type === 'forget-self-archived')
                        forwarder.handle(pair.agent, message);
                });
                return link;
            },
        },
        appVersion: APP_VERSION,
        registry: new SessionRegistry(),
        renderer: fakeRenderer(),
        hooks: {receive: () => ({withdraw() {}}), turnEnded() {}, promptSubmitted() {}, subagentChanged() {}},
        archiveTool: {request: () => ({ok: true, message: ''}), turnEnded() {}},
        timers: fakeTimers(),
        clock: {now: () => 0},
        log: silentLog,
    });

    const archived: string[] = [];
    const catchUp = new SelfArchiveCatchUp({
        appVersion: catchUpVersion,
        remoteProjects: () => projects,
        archiver: {archiveStopped: (sessionId) => void archived.push(sessionId)},
        log: silentLog,
    });
    const caughtUp: Promise<void>[] = [];
    client.onConnected((connection) => void caughtUp.push(catchUp.connected(connection)));

    return {
        agent,
        file,
        archived,
        /** Dial the host and wait for the catch-up to finish. */
        async connect() {
            await client.connection(HOST).whenConnected();
            await settle();
            await Promise.all(caughtUp);
        },
    };
}

test('on connect the Mac archives the rows the agent recorded, then the agent forgets them', async () => {
    /* Given */
    const h = harness({
        record: [
            {sessionId: 's1', archivedAt: 1},
            {sessionId: 's2', archivedAt: 2},
        ],
        projects: [vmProject(['s1', 's2', 's-still-running'])],
    });

    /* When */
    await h.connect();

    /* Then */
    assert.deepEqual(h.archived, ['s1', 's2']);
    assert.deepEqual(
        h.agent.sent('forget-self-archived').map((m) => m.sessionIds),
        [['s1', 's2']],
    );
    assert.deepEqual(JSON.parse(h.file.text ?? 'null'), []);
});

test('ids the Mac does not know are forgotten too, without archiving anything', async () => {
    /* Given */
    const h = harness({
        record: [
            {sessionId: 's1', archivedAt: 1},
            {sessionId: 'from-another-mac', archivedAt: 2},
            {sessionId: 'on-another-host', archivedAt: 3},
        ],
        projects: [vmProject(['s1']), vmProject(['on-another-host'], {host: 'other.local'})],
    });

    /* When */
    await h.connect();

    /* Then */
    assert.deepEqual(h.archived, ['s1']);
    assert.deepEqual(
        h.agent.sent('forget-self-archived').map((m) => m.sessionIds),
        [['s1', 'from-another-mac', 'on-another-host']],
    );
    assert.deepEqual(JSON.parse(h.file.text ?? 'null'), []);
});

test('a session recorded on an agentless remote of the same host is not a VM session', async () => {
    /* Given */
    const h = harness({
        record: [{sessionId: 's1', archivedAt: 1}],
        projects: [vmProject(['s1'], {agent: undefined})],
    });

    /* When */
    await h.connect();

    /* Then */
    assert.deepEqual(h.archived, []);
    assert.deepEqual(
        h.agent.sent('forget-self-archived').map((m) => m.sessionIds),
        [['s1']],
    );
});

test('an empty record is listed and nothing is forgotten', async () => {
    /* Given */
    const h = harness({record: [], projects: [vmProject(['s1'])]});

    /* When */
    await h.connect();

    /* Then */
    assert.equal(h.agent.sent('list-self-archived').length, 1);
    assert.deepEqual(h.archived, []);
    assert.deepEqual(h.agent.sent('forget-self-archived'), []);
});

test('an agent at another version is not asked, since it would refuse the message', async () => {
    /* Given */
    const h = harness({
        record: [{sessionId: 's1', archivedAt: 1}],
        projects: [vmProject(['s1'])],
        catchUpVersion: '2.13.0',
    });

    /* When */
    await h.connect();

    /* Then */
    assert.deepEqual(h.agent.sent('list-self-archived'), []);
    assert.deepEqual(h.archived, []);
});

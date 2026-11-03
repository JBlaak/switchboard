import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {AgentClient} from '../src/application/services/agent-client/agent-client';
import {DroppedFilesService, safeName} from '../src/application/services/dropped-files-service';
import {fakeRenderer, fakePty, fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent} from './support/scripted-agent';
import type {AgentDialer} from '../src/application/ports/agent-link';
import type {DropFileReader} from '../src/application/services/dropped-files-service';

/**
 * Files dropped on a VM session's terminal (#276 story 40): each is read on
 * the Mac, uploaded over the host's link, placed by the agent, and the VM's
 * paths come back in the order dropped. Anything else is refused whole.
 */

const HOST = {user: 'dev', host: 'vm.local', port: 22};
const VM_SITE = 'ssh://dev@vm.local/~/projects/site';
const DROPS = '/home/dev/.switchboard/drops';

/** A Mac disk of regular files and folders, by path. */
function disk(entries: Record<string, string | 'dir'>): DropFileReader {
    return {
        stat: (path) => {
            const entry = entries[path];
            if (entry === undefined) return null;
            return entry === 'dir' ? {isFile: false, size: 0} : {isFile: true, size: Buffer.byteLength(entry)};
        },
        read: (path) => Buffer.from(entries[path] as string),
        basename: (path) => path.split('/').pop() ?? path,
    };
}

function harness(files: DropFileReader, {capBytes}: {capBytes?: number} = {}) {
    const agent = scriptedAgent();
    /** The bytes the agent received, by upload id, and every placement asked for. */
    const received = new Map<string, Buffer[]>();
    const placed: {uploadId: string; name: string}[] = [];
    let refuse: string | null = null;
    const dialer: AgentDialer = {
        async dial(host) {
            const mac = await agent.dialer.dial(host);
            const pair = agent.current();
            pair.agent.onMessage((message) => {
                if (message.type === 'upload-begin') received.set(message.uploadId, []);
                else if (message.type === 'upload-chunk')
                    received.get(message.uploadId)?.push(Buffer.from(message.dataBase64, 'base64'));
                else if (message.type === 'upload-end') {
                    const bytes = Buffer.concat(received.get(message.uploadId) ?? []);
                    const ok = createHash('sha256').update(bytes).digest('hex') === message.sha256;
                    pair.agent.send({type: 'done', requestId: message.requestId, ok});
                } else if (message.type === 'place-upload') {
                    placed.push({uploadId: message.uploadId, name: message.name});
                    pair.agent.send(
                        refuse
                            ? {type: 'placed', requestId: message.requestId, ok: false, error: refuse}
                            : {
                                  type: 'placed',
                                  requestId: message.requestId,
                                  ok: true,
                                  path: `${DROPS}/${message.name}`,
                              },
                    );
                }
            });
            return mac;
        },
    };
    const timers = fakeTimers();
    const clock = {now: () => 0};
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const client = new AgentClient({
        dialer,
        appVersion: '2.12.0',
        registry,
        renderer,
        questions: {receive: () => ({withdraw() {}}), receiveRound() {}, promptSubmitted() {}},
        archiveTool: {request: () => ({ok: true, message: ''}), turnEnded() {}},
        timers,
        clock,
        log: silentLog,
    });
    const drops = new DroppedFilesService({
        registry,
        agents: client,
        files,
        sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
        log: silentLog,
        ...(capBytes !== undefined ? {capBytes} : {}),
    });

    /** A running VM session, its PTY the agent client's stand-in. */
    const vmSession = async (sessionId = 'vm-1') => {
        const {pty, opened} = client.startSession({
            sessionId,
            host: HOST,
            kind: 'claude',
            dir: '~/projects/site',
            isNew: true,
            cols: 120,
            rows: 30,
        });
        registry.add(sessionId, session(pty, VM_SITE));
        await opened;
    };
    const localSession = (sessionId = 'local-1') => registry.add(sessionId, session(fakePty(), '/code/site'));

    return {
        agent,
        drops,
        received,
        placed,
        vmSession,
        localSession,
        refuse: (reason: string) => (refuse = reason),
    };
}

function session(pty: ConstructorParameters<typeof ActiveSession>[0]['pty'], projectPath: string): ActiveSession {
    return new ActiveSession({
        pty,
        projectPath,
        projectFolder: null,
        knownTranscriptIds: null,
        sessionSlug: null,
        isPlainTerminal: false,
        remote: null,
        openedAt: 0,
    });
}

test('dropped files are uploaded and placed on the VM, and their VM paths answered in order', async () => {
    /* Given */
    const h = harness(disk({'/Users/joris/b.png': 'png bytes', '/Users/joris/a.txt': 'hello'}));
    await h.vmSession();

    /* When */
    const result = await h.drops.toSession('vm-1', ['/Users/joris/b.png', '/Users/joris/a.txt']);

    /* Then */
    assert.deepEqual(result, {ok: true, paths: [`${DROPS}/b.png`, `${DROPS}/a.txt`]});
    assert.deepEqual(
        h.placed.map((p) => p.name),
        ['b.png', 'a.txt'],
    );
    assert.deepEqual(
        h.placed.map((p) => Buffer.concat(h.received.get(p.uploadId) ?? []).toString()),
        ['png bytes', 'hello'],
    );
});

test('a file over the cap fails the whole drop before anything is sent', async () => {
    /* Given */
    const h = harness(disk({'/Users/joris/a.txt': 'hello', '/Users/joris/big.bin': 'x'.repeat(11)}), {capBytes: 10});
    await h.vmSession();

    /* When */
    const result = await h.drops.toSession('vm-1', ['/Users/joris/a.txt', '/Users/joris/big.bin']);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'big.bin is larger than 10 bytes.'});
    assert.deepEqual(h.agent.sent('upload-begin'), []);
});

test('a folder is refused: only regular files are dropped on a VM', async () => {
    /* Given */
    const h = harness(disk({'/Users/joris/photos': 'dir'}));
    await h.vmSession();

    /* When */
    const result = await h.drops.toSession('vm-1', ['/Users/joris/photos']);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'photos is not a file; only files can be dropped on a VM.'});
    assert.deepEqual(h.agent.sent('upload-begin'), []);
});

test('a missing file is refused', async () => {
    /* Given */
    const h = harness(disk({}));
    await h.vmSession();

    /* When */
    const result = await h.drops.toSession('vm-1', ['/Users/joris/gone.txt']);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'gone.txt could not be read.'});
});

test('a local session is refused: its terminal pastes its own paths', async () => {
    /* Given */
    const h = harness(disk({'/Users/joris/a.txt': 'hello'}));
    h.localSession();

    /* When */
    const result = await h.drops.toSession('local-1', ['/Users/joris/a.txt']);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'That session is not on a VM.'});
    assert.equal(h.agent.dials.length, 0);
});

test('a session that is not running is refused', async () => {
    /* Given */
    const h = harness(disk({'/Users/joris/a.txt': 'hello'}));

    /* When */
    const result = await h.drops.toSession('nope', ['/Users/joris/a.txt']);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'That session is not running.'});
});

test("the agent's refusal to place a file is the drop's error", async () => {
    /* Given */
    const h = harness(disk({'/Users/joris/a.txt': 'hello'}));
    await h.vmSession();
    h.refuse('the drop folder is full');

    /* When */
    const result = await h.drops.toSession('vm-1', ['/Users/joris/a.txt']);

    /* Then */
    assert.deepEqual(result, {ok: false, error: 'The VM did not take a.txt: the drop folder is full'});
});

test('a name is kept as one safe segment', () => {
    /* When */
    const names = [safeName('a/b.txt'), safeName('..'), safeName('tab\there.md'), safeName('report.pdf')];

    /* Then */
    assert.deepEqual(names, ['a_b.txt', 'file', 'tab_here.md', 'report.pdf']);
});

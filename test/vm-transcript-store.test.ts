import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptStore} from '../src/infrastructure/fs/transcript-store';
import {RoutingTranscriptStore, type TranscriptQueryLink} from '../src/infrastructure/agent/routing-transcript-store';
import {vmFolder, vmPath, type VmHost} from '../src/domain/agent/vm-paths';
import type {TranscriptQueryMethod} from '../src/domain/agent/protocol';
import type {Logger} from '../src/application/ports/logger';

const HOST: VmHost = {user: 'dev', host: 'vm.local', port: 2222};
const VM_ROOT = '/home/dev/projects/site';
const VM_WORKTREE = VM_ROOT + '/.claude/worktrees/12-billing';
const VM_ENCODED = '-home-dev-projects-site';
const FOLDER = vmFolder(HOST, VM_ENCODED);
const SESSION = '7a1c2a6e-2222-4c4c-9a9a-0123456789ab';
const PROJECT = vmPath(HOST, '~/projects/site');

const LOCAL_ROOT = '/Users/me/dev/web';
const LOCAL_FOLDER = '-Users-me-dev-web';

let vmDir: string;
let macDir: string;
let vmStore: FileTranscriptStore;
let macStore: FileTranscriptStore;

const line = (cwd: string, gitBranch: string, text: string) =>
    JSON.stringify({
        type: 'user',
        cwd,
        gitBranch,
        sessionId: SESSION,
        timestamp: '2026-10-16T09:00:00Z',
        message: {role: 'user', content: text},
    });

function writeLines(file: string, lines: string[]): void {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, lines.join('\n') + '\n');
}

before(() => {
    vmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-vm-projects-'));
    macDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-mac-projects-'));
    writeLines(path.join(vmDir, VM_ENCODED, SESSION + '.jsonl'), [
        line(VM_ROOT, 'main', 'Work through #12 on the VM.'),
        line(VM_WORKTREE, '12-billing', 'Now in the worktree.'),
        JSON.stringify({
            type: 'pr-link',
            sessionId: SESSION,
            prNumber: 40,
            prUrl: 'https://github.com/acme/site/pull/40',
            prRepository: 'acme/site',
        }),
    ]);
    writeLines(path.join(macDir, LOCAL_FOLDER, SESSION + '.jsonl'), [line(LOCAL_ROOT, 'feat/9', 'Local work on #9.')]);
    vmStore = new FileTranscriptStore(new NodeFileSystem(), vmDir);
    macStore = new FileTranscriptStore(new NodeFileSystem(), macDir);
});

after(() => {
    fs.rmSync(vmDir, {recursive: true, force: true});
    fs.rmSync(macDir, {recursive: true, force: true});
});

const silent: Logger = {debug() {}, info() {}, warn() {}, error() {}};

/** The VM's agent: its own FileTranscriptStore, answered through a JSON round trip as the link carries it. */
function agentLink(calls: {method: TranscriptQueryMethod; args: unknown[]}[] = []): TranscriptQueryLink {
    return {
        async transcriptQuery(method, args) {
            calls.push({method, args});
            const call = vmStore[method] as (...a: unknown[]) => unknown;
            const answer = call.apply(vmStore, args);
            return answer === undefined ? null : (JSON.parse(JSON.stringify(answer)) as unknown);
        },
    };
}

function router(link: TranscriptQueryLink | null = agentLink(), hosts: VmHost[] = []): RoutingTranscriptStore {
    return new RoutingTranscriptStore({
        local: macStore,
        link: (host) => {
            hosts.push(host);
            return link;
        },
        log: silent,
    });
}

test('a VM folder’s locations are asked of its host, with the VM folder name, and come back VM-named', async () => {
    /* Given */
    const calls: {method: TranscriptQueryMethod; args: unknown[]}[] = [];
    const hosts: VmHost[] = [];
    const store = router(agentLink(calls), hosts);

    /* When */
    const locations = await store.locations(FOLDER, SESSION);

    /* Then */
    assert.deepEqual(hosts, [HOST]);
    assert.deepEqual(calls, [{method: 'locations', args: [VM_ENCODED, SESSION]}]);
    assert.deepEqual(locations, [
        {cwd: vmPath(HOST, VM_ROOT), branch: 'main', fromSubagent: false},
        {cwd: vmPath(HOST, VM_WORKTREE), branch: '12-billing', fromSubagent: false},
    ]);
});

test('a VM session is read with its VM path, and keeps the Mac’s folder and project names', async () => {
    /* Given */
    const calls: {method: TranscriptQueryMethod; args: unknown[]}[] = [];
    const store = router(agentLink(calls));

    /* When */
    const session = await store.readSession(FOLDER, SESSION, PROJECT);

    /* Then */
    assert.deepEqual(calls[0].args, [VM_ENCODED, SESSION, '~/projects/site']);
    assert.equal(session?.folder, FOLDER);
    assert.equal(session?.projectPath, PROJECT);
    assert.deepEqual(session?.pullRequests, [
        {number: 40, url: 'https://github.com/acme/site/pull/40', repository: 'acme/site'},
    ]);
});

test('a VM session’s issue mentions come from its VM', async () => {
    /* When */
    const mentions = await router().issueMentions(FOLDER, SESSION, 'acme/site');

    /* Then */
    assert.deepEqual(mentions, [{repository: 'acme/site', number: 12}]);
});

test('a VM folder’s project path resolves on the VM and comes back VM-named', async () => {
    /* When */
    const resolved = await router().resolveProjectPath(FOLDER);

    /* Then */
    assert.equal(resolved, vmPath(HOST, VM_ROOT));
});

test('a VM transcript’s head, tail and mtime are read on the VM', async () => {
    /* Given */
    const store = router();

    /* When */
    const [head, tail, mtime] = await Promise.all([
        store.readHeadLines(FOLDER, SESSION, 100_000),
        store.readTail(FOLDER, SESSION, 100_000),
        store.sessionMtimeMs(FOLDER, SESSION),
    ]);

    /* Then */
    assert.equal(head.length, 3);
    assert.match(tail, /pr-link/);
    assert.equal(mtime, vmStore.sessionMtimeMs(VM_ENCODED, SESSION));
});

test('a local folder goes to the Mac’s store unchanged, never to a link', async () => {
    /* Given */
    const hosts: VmHost[] = [];
    const store = router(agentLink(), hosts);

    /* When */
    const locations = await store.locations(LOCAL_FOLDER, SESSION);
    const session = await store.readSession(LOCAL_FOLDER, SESSION, LOCAL_ROOT);
    const exists = store.folderExists(LOCAL_FOLDER);

    /* Then */
    assert.deepEqual(locations, macStore.locations(LOCAL_FOLDER, SESSION));
    assert.deepEqual(session, macStore.readSession(LOCAL_FOLDER, SESSION, LOCAL_ROOT));
    assert.equal(exists, true);
    assert.deepEqual(hosts, []);
});

test('a host that is not connected answers empty', async () => {
    /* Given */
    const store = router(null);

    /* When */
    const answers = await Promise.all([
        store.locations(FOLDER, SESSION),
        store.readSession(FOLDER, SESSION, PROJECT),
        store.issueMentions(FOLDER, SESSION, 'acme/site'),
        store.resolveProjectPath(FOLDER),
        store.readHeadLines(FOLDER, SESSION, 10),
        store.readTail(FOLDER, SESSION, 10),
        store.sessionMtimeMs(FOLDER, SESSION),
    ]);

    /* Then */
    assert.deepEqual(answers, [[], null, [], null, [], '', null]);
});

test('an agent that fails, or answers the wrong shape, answers empty rather than throwing', async () => {
    /* Given */
    const failing = router({transcriptQuery: async () => Promise.reject(new Error('timed out'))});
    const odd = router({transcriptQuery: async () => ({not: 'a list'})});

    /* When */
    const failed = await failing.locations(FOLDER, SESSION);
    const shapeless = await Promise.all([odd.locations(FOLDER, SESSION), odd.readSession(FOLDER, SESSION, PROJECT)]);

    /* Then */
    assert.deepEqual(failed, []);
    assert.deepEqual(shapeless, [[], null]);
});

test('the reads the agent does not answer are empty for a VM folder, and ask nothing', () => {
    /* Given */
    const hosts: VmHost[] = [];
    const store = router(agentLink(), hosts);

    /* When */
    const answers = [
        store.folderExists(FOLDER),
        store.listSessionIds(FOLDER),
        store.folderIndexMtimeMs(FOLDER),
        store.sessionFingerprint(FOLDER, SESSION),
        store.readSlug(FOLDER, SESSION),
    ];
    store.seedSession(FOLDER, SESSION, [{type: 'user'}]);

    /* Then */
    assert.deepEqual(answers, [false, [], 0, null, null]);
    assert.deepEqual(hosts, []);
    assert.deepEqual(store.listFolders(), [LOCAL_FOLDER]);
});

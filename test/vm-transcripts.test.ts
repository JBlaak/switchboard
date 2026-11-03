/**
 * The Mac's VM transcripts (#292): asked for over the agent link on connect
 * and on `transcripts-changed`, kept across restarts, and what VM rows take
 * their titles, PRs and search text from.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SessionRegistry} from '../src/application/model/session-registry';
import {AgentClient} from '../src/application/services/agent-client/agent-client';
import {VmTranscripts, vmSearchFolder} from '../src/application/services/vm-transcripts';
import {buildProjectList} from '../src/domain/project/project-list';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import {scriptedAgent, settle} from './support/scripted-agent';
import type {AgentDialer} from '../src/application/ports/agent-link';
import type {SearchIndex} from '../src/application/ports/search-index';
import type {VmTranscriptEntry, VmTranscriptStore} from '../src/application/ports/vm-transcript-store';
import type {AgentTranscript, MacMessage} from '../src/domain/agent/protocol';
import type {SearchEntry} from '../src/domain/search/search';
import type {CachedSession, Session, SessionMeta} from '../src/domain/session/session';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

const HOST_KEY = 'joris@vm.local:22';
const PROJECT = 'ssh://joris@vm.local/proj';

function vmProject(sessions: RemoteProjectSetting['sessions']): RemoteProjectSetting {
    return {
        user: 'joris',
        host: 'vm.local',
        port: 22,
        dir: 'proj',
        agent: {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'},
        sessions,
    };
}

function session(sessionId: string, overrides: Partial<Session> = {}): Session {
    return {
        sessionId,
        folder: '-home-joris-proj',
        projectPath: '/home/joris/proj',
        summary: `Fix the ${sessionId} bug`,
        firstPrompt: `Fix the ${sessionId} bug please`,
        created: '2026-11-02T09:00:00.000Z',
        modified: '2026-11-02T10:00:00.000Z',
        fileMtime: '2026-11-02T10:00:00.000Z',
        messageCount: 12,
        textContent: `the conversation about ${sessionId}`,
        slug: 'calm-river',
        customTitle: null,
        aiTitle: `AI title ${sessionId}`,
        pullRequests: [{number: 7, url: 'https://github.com/me/app/pull/7', repository: 'me/app'}],
        ...overrides,
    };
}

function transcript(sessionId: string, mtimeMs = 1000, overrides: Partial<Session> = {}): AgentTranscript {
    return {cwd: '/home/joris/proj', mtimeMs, session: session(sessionId, overrides)};
}

class MemoryStore implements VmTranscriptStore {
    public readonly rows = new Map<string, VmTranscriptEntry>();
    public all(): VmTranscriptEntry[] {
        return [...this.rows.values()].map((e) => structuredClone(e));
    }
    public put(entry: VmTranscriptEntry): void {
        this.rows.set(entry.sessionId, structuredClone(entry));
    }
    public delete(sessionId: string): void {
        this.rows.delete(sessionId);
    }
}

/** A search index that matches a query as a substring of an entry's title or body, as the trigram FTS does. */
class MemorySearch implements Pick<SearchIndex, 'upsert' | 'deleteSession' | 'query'> {
    public readonly entries = new Map<string, SearchEntry>();
    public upsert(entries: readonly SearchEntry[]): void {
        for (const entry of entries) this.entries.set(entry.id, entry);
    }
    public deleteSession(sessionId: string): void {
        this.entries.delete(sessionId);
    }
    public query(_type: 'session', query: string) {
        const q = query.toLowerCase();
        return [...this.entries.values()]
            .filter((e) => `${e.title} ${e.body}`.toLowerCase().includes(q))
            .map((e) => ({id: e.id, snippet: ''}));
    }
}

interface Harness {
    service: VmTranscripts;
    client: AgentClient;
    agent: ReturnType<typeof scriptedAgent>;
    /** What the scripted agent answers to `get-transcript`, by session id; absent answers null. */
    answers: Map<string, AgentTranscript | null>;
    tails: Map<string, string[]>;
    store: MemoryStore;
    search: MemorySearch;
    renderer: ReturnType<typeof fakeRenderer>;
    names: Map<string, string>;
    remotes: RemoteProjectSetting[];
    connect(): Promise<void>;
    asked(): string[];
    build(service?: VmTranscripts): VmTranscripts;
}

function harness({
    remotes = [vmProject([{sessionId: 'c1', kind: 'claude', created: '2026-11-02T08:00:00.000Z'}])],
    store = new MemoryStore(),
    search = new MemorySearch(),
}: {remotes?: RemoteProjectSetting[]; store?: MemoryStore; search?: MemorySearch} = {}): Harness {
    const agent = scriptedAgent();
    const answers = new Map<string, AgentTranscript | null>();
    const tails = new Map<string, string[]>();
    // Plays the agent's transcript side on every link, hooked in before `hello` goes out.
    const dialer: AgentDialer = {
        async dial(host) {
            const link = await agent.dialer.dial(host);
            const pair = agent.current();
            pair.agent.onMessage((message: MacMessage) => {
                if (message.type === 'get-transcript')
                    pair.agent.send({
                        type: 'transcript',
                        requestId: message.requestId,
                        transcript: answers.get(message.sessionId) ?? null,
                    });
                if (message.type === 'transcript-tail')
                    pair.agent.send({
                        type: 'transcript-tail',
                        requestId: message.requestId,
                        lines: tails.get(message.sessionId) ?? [],
                    });
            });
            return link;
        },
    };
    const renderer = fakeRenderer();
    const client = new AgentClient({
        dialer,
        appVersion: '2.12.0',
        registry: new SessionRegistry(),
        renderer,
        questions: {receive: () => ({withdraw() {}}), receiveRound() {}, promptSubmitted() {}},
        archiveTool: {request: () => ({ok: true, message: ''}), turnEnded() {}},
        timers: fakeTimers(),
        clock: {now: () => 0},
        log: silentLog,
    });
    const names = new Map<string, string>();
    const build = () =>
        new VmTranscripts({
            agents: client,
            remoteProjects: () => remotes,
            store,
            searchIndex: search,
            names: {
                getMeta: (id): SessionMeta | null =>
                    names.has(id)
                        ? {sessionId: id, name: names.get(id) ?? null, starred: 0, archived: 0, snoozedUntil: null}
                        : null,
                setName: (id, name) => void (name ? names.set(id, name) : names.delete(id)),
            },
            renderer,
            log: silentLog,
        });
    const service = build();
    return {
        service,
        client,
        agent,
        answers,
        tails,
        store,
        search,
        renderer,
        names,
        remotes,
        build,
        async connect() {
            await client.connection(remotes[0]).whenConnected();
            await settle();
        },
        asked: () => agent.sent('get-transcript').map((m) => m.sessionId),
    };
}

function rows(remotes: RemoteProjectSetting[], vmTranscripts: ReadonlyMap<string, CachedSession>) {
    return buildProjectList({
        cached: [],
        meta: new Map(),
        hiddenProjects: new Set(),
        knownProjectPaths: [],
        activeTerminals: [],
        remoteProjects: remotes,
        pinnedPlans: [],
        pinnedIssuePlans: [],
        showArchived: false,
        vmTranscripts,
    }).find((p) => p.projectPath === PROJECT)?.sessions;
}

test('on connect, every Claude session recorded on the host is asked for, and the renderer told once', async () => {
    /* Given */
    const h = harness({
        remotes: [
            vmProject([
                {sessionId: 'c1', kind: 'claude', created: '2026-11-02T08:00:00.000Z'},
                {sessionId: 'c2', kind: 'claude', created: '2026-11-02T08:00:00.000Z'},
            ]),
        ],
    });
    h.answers.set('c1', transcript('c1'));
    h.answers.set('c2', transcript('c2'));

    /* When */
    await h.connect();

    /* Then */
    assert.deepEqual(h.asked().sort(), ['c1', 'c2']);
    assert.equal(h.service.get('c1')?.summary, 'Fix the c1 bug');
    assert.equal(h.service.get('c2')?.aiTitle, 'AI title c2');
    assert.equal(h.renderer.only('projectsChanged').length, 1);
});

test('shell sessions are not asked for: they have no transcript', async () => {
    /* Given */
    const h = harness({
        remotes: [
            vmProject([
                {sessionId: 'c1', kind: 'claude', created: '2026-11-02T08:00:00.000Z'},
                {sessionId: 'sh1', kind: 'shell', created: '2026-11-02T08:00:00.000Z'},
            ]),
        ],
    });

    /* When */
    await h.connect();

    /* Then */
    assert.deepEqual(h.asked(), ['c1']);
});

test('a reconnect asks again', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1'));
    await h.connect();

    /* When */
    h.agent.current().drop('wifi');
    await settle();
    h.client.connection(h.remotes[0]).retryNow();
    await settle();
    await settle();

    /* Then */
    assert.deepEqual(h.asked(), ['c1', 'c1']);
});

test('transcripts-changed asks again for those sessions and tells the renderer', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1', 1000));
    await h.connect();
    h.answers.set('c1', transcript('c1', 2000, {summary: 'Now about the parser', messageCount: 30}));

    /* When */
    h.agent.send({type: 'transcripts-changed', sessionIds: ['c1']});
    await settle();

    /* Then */
    assert.deepEqual(h.asked(), ['c1', 'c1']);
    assert.equal(h.service.get('c1')?.summary, 'Now about the parser');
    assert.equal(h.service.get('c1')?.messageCount, 30);
    assert.equal(h.renderer.only('projectsChanged').length, 2);
});

test('an answer that is no news (same mtime) does not tell the renderer', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1', 1000));
    await h.connect();

    /* When */
    h.agent.send({type: 'transcripts-changed', sessionIds: ['c1', 'not-recorded-here']});
    await settle();

    /* Then */
    assert.deepEqual(h.asked(), ['c1', 'c1']);
    assert.equal(h.renderer.only('projectsChanged').length, 1);
});

test('the cache survives a new service instance, as after a restart', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1'));
    await h.connect();

    /* When */
    const restarted = h.build();

    /* Then */
    assert.equal(restarted.get('c1')?.summary, 'Fix the c1 bug');
    assert.equal(restarted.cwd('c1'), '/home/joris/proj');
    assert.deepEqual(restarted.pullRequests('c1'), [
        {number: 7, url: 'https://github.com/me/app/pull/7', repository: 'me/app'},
    ]);
    assert.equal(h.store.rows.get('c1')?.hostKey, HOST_KEY);
    assert.equal('textContent' in (h.store.rows.get('c1')?.transcript ?? {}), false);
});

test('a VM row takes its title, prompt, count, slug and PRs from the cache', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1'));
    await h.connect();

    /* When */
    const sessions = rows(h.remotes, h.service.forList(h.remotes));

    /* Then */
    const row = sessions?.find((s) => s.sessionId === 'c1');
    assert.equal(row?.summary, 'Fix the c1 bug');
    assert.equal(row?.firstPrompt, 'Fix the c1 bug please');
    assert.equal(row?.aiTitle, 'AI title c1');
    assert.equal(row?.slug, 'calm-river');
    assert.equal(row?.messageCount, 12);
    assert.equal(row?.modified, '2026-11-02T10:00:00.000Z');
    assert.equal(row?.pullRequests?.[0]?.number, 7);
    assert.equal(row?.type, 'remote');
    assert.equal(row?.remoteKind, 'claude');
});

test('full-text search finds a VM session by its text, under its own id', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1', 1000, {textContent: 'we rewrote the flux capacitor'}));

    /* When */
    await h.connect();

    /* Then */
    assert.deepEqual(
        h.search.query('session', 'flux capacitor').map((r) => r.id),
        ['c1'],
    );
    assert.equal(h.search.entries.get('c1')?.folder, vmSearchFolder(HOST_KEY));
    assert.match(h.search.entries.get('c1')?.title ?? '', /AI title c1/);
});

test('a session whose record goes away leaves the cache and the search index', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1'));
    await h.connect();

    /* When */
    const map = h.service.forList([vmProject([])]);

    /* Then */
    assert.equal(map.size, 0);
    assert.equal(h.service.get('c1'), null);
    assert.equal(h.store.rows.has('c1'), false);
    assert.equal(h.search.entries.has('c1'), false);
});

test('a session recorded after the connect is asked for when the list is next built', async () => {
    /* Given */
    const h = harness();
    await h.connect();
    h.remotes[0].sessions?.push({sessionId: 'c2', kind: 'claude', created: '2026-11-02T11:00:00.000Z'});
    h.answers.set('c2', transcript('c2'));

    /* When */
    h.service.forList(h.remotes);
    await settle();
    h.service.forList(h.remotes);
    await settle();

    /* Then */
    assert.deepEqual(h.asked(), ['c1', 'c2']);
    assert.equal(h.service.get('c2')?.summary, 'Fix the c2 bug');
});

test('an unreachable host keeps its cached rows, and a tail of its session is empty', async () => {
    /* Given */
    const store = new MemoryStore();
    store.put({
        sessionId: 'c1',
        hostKey: HOST_KEY,
        cwd: '/home/joris/proj',
        mtimeMs: 1000,
        transcript: (({textContent: _t, customTitle: _c, ...rest}) => rest)(session('c1')),
    });
    const h = harness({store});

    /* When */
    const sessions = rows(h.remotes, h.service.forList(h.remotes));
    const tail = await h.service.tail('c1', 4096);

    /* Then */
    assert.equal(sessions?.find((s) => s.sessionId === 'c1')?.summary, 'Fix the c1 bug');
    assert.deepEqual(tail, []);
    assert.equal(h.agent.dials.length, 0);
});

test('a tail goes through a connected link', async () => {
    /* Given */
    const h = harness();
    h.tails.set('c1', ['{"type":"user"}', '{"type":"assistant"}']);
    await h.connect();

    /* When */
    const tail = await h.service.tail('c1', 4096);

    /* Then */
    assert.deepEqual(tail, ['{"type":"user"}', '{"type":"assistant"}']);
    assert.deepEqual(
        h.agent.sent('transcript-tail').map((m) => [m.sessionId, m.bytes]),
        [['c1', 4096]],
    );
});

test("a CLI /title on the VM becomes the session's name, as for a local session", async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1', 1000, {customTitle: 'Parser rewrite'}));

    /* When */
    await h.connect();

    /* Then */
    assert.equal(h.names.get('c1'), 'Parser rewrite');
});

test('a null answer keeps what was cached', async () => {
    /* Given */
    const h = harness();
    h.answers.set('c1', transcript('c1'));
    await h.connect();
    h.answers.set('c1', null);

    /* When */
    h.agent.send({type: 'transcripts-changed', sessionIds: ['c1']});
    await settle();

    /* Then */
    assert.equal(h.service.get('c1')?.summary, 'Fix the c1 bug');
});

/**
 * The project list's VM inputs (#292): a VM Claude row takes its transcript's
 * fields from `vmTranscripts`, and a local row of a session handed off to a
 * VM is left out, so the VM row stands for it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildProjectList} from '../src/domain/project/project-list';
import type {ProjectListInputs} from '../src/domain/project/project-list';
import type {CachedSession} from '../src/domain/session/session';
import type {RemoteProjectSetting} from '../src/domain/settings/settings';

const PROJECT = 'ssh://joris@vm.local/proj';

function cached(sessionId: string, overrides: Partial<CachedSession> = {}): CachedSession {
    return {
        sessionId,
        folder: '-Users-joris-proj',
        projectPath: '/Users/joris/proj',
        summary: `About ${sessionId}`,
        firstPrompt: `About ${sessionId}, please`,
        created: '2026-11-02T09:00:00.000Z',
        modified: '2026-11-02T10:00:00.000Z',
        fileMtime: '2026-11-02T10:00:00.000Z',
        messageCount: 4,
        slug: null,
        aiTitle: null,
        pullRequests: [{number: 3, url: 'https://github.com/me/app/pull/3', repository: 'me/app'}],
        ...overrides,
    };
}

const remote: RemoteProjectSetting = {
    user: 'joris',
    host: 'vm.local',
    port: 22,
    dir: 'proj',
    agent: {version: '2.12.0', installedAt: '2026-11-01T00:00:00.000Z'},
    sessions: [
        {sessionId: 'c1', kind: 'claude', created: '2026-11-02T08:00:00.000Z', lastOpened: '2026-11-02T12:00:00.000Z'},
        {sessionId: 'sh1', kind: 'shell', created: '2026-11-02T08:00:00.000Z'},
    ],
};

function build(overrides: Partial<ProjectListInputs> = {}) {
    return buildProjectList({
        cached: [],
        meta: new Map(),
        hiddenProjects: new Set(),
        knownProjectPaths: [],
        activeTerminals: [],
        remoteProjects: [remote],
        pinnedPlans: [],
        pinnedIssuePlans: [],
        showArchived: false,
        ...overrides,
    });
}

test("a VM row's activity is the later of its last message and its last opening", () => {
    /* Given */
    const vmTranscripts = new Map([['c1', cached('c1', {modified: '2026-11-02T10:00:00.000Z'})]]);

    /* When */
    const row = build({vmTranscripts})
        .find((p) => p.projectPath === PROJECT)
        ?.sessions.find((s) => s.sessionId === 'c1');

    /* Then */
    assert.equal(row?.modified, '2026-11-02T12:00:00.000Z');
    assert.equal(row?.summary, 'About c1');
    assert.equal(row?.pullRequests?.[0]?.number, 3);
});

test('a VM row keeps its name, star and archive from the meta', () => {
    /* Given */
    const vmTranscripts = new Map([['c1', cached('c1')]]);
    const meta = new Map([
        ['c1', {sessionId: 'c1', name: 'Mine', starred: 1 as const, archived: 0 as const, snoozedUntil: null}],
    ]);

    /* When */
    const row = build({vmTranscripts, meta})
        .find((p) => p.projectPath === PROJECT)
        ?.sessions.find((s) => s.sessionId === 'c1');

    /* Then */
    assert.equal(row?.name, 'Mine');
    assert.equal(row?.starred, 1);
    assert.equal(row?.summary, 'About c1');
});

test('without a cache entry a VM row stays as before, and a shell row never takes one', () => {
    /* Given */
    const vmTranscripts = new Map([['sh1', cached('sh1')]]);

    /* When */
    const sessions = build({vmTranscripts}).find((p) => p.projectPath === PROJECT)?.sessions;

    /* Then */
    const claude = sessions?.find((s) => s.sessionId === 'c1');
    const shell = sessions?.find((s) => s.sessionId === 'sh1');
    assert.equal(claude?.summary, 'Remote Claude');
    assert.equal(claude?.pullRequests, undefined);
    assert.equal(shell?.summary, 'Remote terminal');
});

test('a local row of a session handed off to a VM is left out; its VM row stands for it', () => {
    /* Given */
    const local = [cached('c1'), cached('kept')];

    /* When */
    const projects = build({
        cached: local,
        handedOffSessions: new Set(['c1']),
        vmTranscripts: new Map([['c1', cached('c1')]]),
    });

    /* Then */
    const localIds = projects.find((p) => p.projectPath === '/Users/joris/proj')?.sessions.map((s) => s.sessionId);
    const vmIds = projects.find((p) => p.projectPath === PROJECT)?.sessions.map((s) => s.sessionId);
    assert.deepEqual(localIds, ['kept']);
    assert.ok(vmIds?.includes('c1'));
});

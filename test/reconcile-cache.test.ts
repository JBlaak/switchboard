import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {SessionIndex} from '../src/application/services/session-index';
import {NodeFileSystem} from '../src/infrastructure/fs/node-file-system';
import {FileTranscriptStore} from '../src/infrastructure/fs/transcript-store';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import type {CachedSession, FolderMeta, SessionMeta} from '../src/domain/session/session';
import type {ProjectScanner} from '../src/application/ports/project-scanner';
import type {SearchIndex} from '../src/application/ports/search-index';
import type {SessionRepository} from '../src/application/ports/session-repository';

/**
 * The incremental re-index is what keeps sessions from silently going missing:
 * a folder that changed while the app was closed, or that predates the build
 * which first indexed it, is otherwise never picked up — the cold-start rebuild
 * only runs when the cache is completely empty.
 *
 * It also has to be cheap enough to run on every project list, which is why the
 * gate is a stat rather than a read. That is what these check.
 */

/** Write one transcript holding a single entry, making its folder if need be. */
function writeTranscript(folderPath: string, fileName: string, entry: object): void {
    fs.mkdirSync(folderPath, {recursive: true});
    fs.writeFileSync(path.join(folderPath, fileName), `${JSON.stringify(entry)}\n`);
}

/** A coding session as the indexer needs it: a `cwd` to name the project, and one prompt. */
function writeSession(folderPath: string, cwd: string): void {
    writeTranscript(folderPath, 'session.jsonl', {type: 'user', cwd, message: {role: 'user', content: 'hello'}});
}

/** A transcript a tool ran with `claude -p`, as the CLI writes it. */
function writeHeadlessSession(folderPath: string, cwd: string, name = 'headless.jsonl'): void {
    writeTranscript(folderPath, name, {
        type: 'user',
        cwd,
        entrypoint: 'sdk-cli',
        message: {role: 'user', content: 'Answer this question'},
    });
}

const projectsDirs: string[] = [];
after(() => {
    for (const dir of projectsDirs) fs.rmSync(dir, {recursive: true, force: true});
});

/** An empty stand-in for ~/.claude/projects, removed once the file's tests are done. */
function makeProjectsDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-session-index-'));
    projectsDirs.push(dir);
    return dir;
}

/** An in-memory repository that records which folders actually got re-indexed. */
function fakeRepository(meta: Map<string, FolderMeta>) {
    const indexedFolders = new Set<string>();
    const cached = new Map<string, CachedSession>();

    const repository: SessionRepository = {
        getMeta: () => null,
        getAllMeta: () => new Map<string, SessionMeta>(),
        setName() {},
        toggleStar: () => 0,
        setArchived() {},
        setSnoozedUntil() {},
        getPinnedPlans: () => [],
        togglePlanPin: () => false,
        getPinnedIssuePlans: () => [],
        toggleIssuePlanPin: () => false,

        isCachePopulated: () => cached.size > 0,
        getAllCached: () => [...cached.values()],
        getCachedSession: (id) => cached.get(id) ?? null,
        getCachedFolder: (id) => cached.get(id)?.folder ?? null,
        getCachedFingerprints: (folder) =>
            [...cached.values()]
                .filter((s) => s.folder === folder)
                .map(({sessionId, fileMtime}) => ({sessionId, fileMtime})),
        upsertCachedSessions(sessions) {
            for (const session of sessions) {
                indexedFolders.add(session.folder);
                cached.set(session.sessionId, session);
            }
        },
        deleteCachedSession(id) {
            cached.delete(id);
        },
        deleteCachedFolder(folder) {
            for (const [id, session] of cached) if (session.folder === folder) cached.delete(id);
            meta.delete(folder);
        },

        getAllFolderMeta: () => meta,
        setFolderMeta(folder, projectPath, indexMtimeMs) {
            meta.set(folder, {folder, projectPath, indexMtimeMs});
        },
    };

    return {repository, indexedFolders, cached};
}

const noSearchIndex: SearchIndex = {
    isPopulated: () => true,
    wasRecreated: () => false,
    upsert() {},
    deleteSession() {},
    deleteFolder() {},
    updateTitle() {},
    query: () => [],
};

const noScanner: ProjectScanner = {scan: async () => []};

function build(projectsDir: string, meta: Map<string, FolderMeta>) {
    const {repository, indexedFolders, cached} = fakeRepository(meta);
    const transcripts = new FileTranscriptStore(new NodeFileSystem(), projectsDir);
    const index = new SessionIndex({
        repository,
        searchIndex: noSearchIndex,
        transcripts,
        scanner: noScanner,
        renderer: fakeRenderer(),
        timers: fakeTimers(),
        log: silentLog,
    });
    return {index, indexedFolders, cached, transcripts};
}

test('reconcile indexes new and stale folders but skips up-to-date ones', () => {
    /* Given */
    const projectsDir = makeProjectsDir();
    // One folder never indexed, one indexed before its transcript was written,
    // and one indexed since.
    for (const folder of ['proj-new', 'proj-stale', 'proj-current']) {
        writeSession(path.join(projectsDir, folder), `/tmp/${folder}`);
    }

    const meta = new Map<string, FolderMeta>([
        ['proj-stale', {folder: 'proj-stale', projectPath: '/tmp/proj-stale', indexMtimeMs: 0}],
    ]);
    const {index, indexedFolders, transcripts} = build(projectsDir, meta);
    meta.set('proj-current', {
        folder: 'proj-current',
        projectPath: '/tmp/proj-current',
        indexMtimeMs: transcripts.folderIndexMtimeMs('proj-current'),
    });

    /* When */
    index.reconcile();

    /* Then */
    assert.ok(indexedFolders.has('proj-new'), 'a folder with no meta should be indexed');
    assert.ok(indexedFolders.has('proj-stale'), 'a folder newer than its gate should be re-indexed');
    assert.ok(!indexedFolders.has('proj-current'), 'an up-to-date folder should be skipped');
});

test('a folder is re-read only for the transcripts whose mtime moved', () => {
    /* Given */
    const projectsDir = makeProjectsDir();
    writeSession(path.join(projectsDir, 'proj'), '/tmp/proj');
    const {index, indexedFolders, cached} = build(projectsDir, new Map());

    /* When */
    index.refreshFolder('proj');

    /* Then */
    assert.equal(cached.size, 1, 'the transcript is read the first time');

    // Nothing changed on disk, so the fingerprint match short-circuits the read.
    /* When */
    indexedFolders.clear();
    index.refreshFolder('proj');

    /* Then */
    assert.ok(!indexedFolders.has('proj'), 'an unchanged transcript is not re-read');
});

test('one deleted transcript among several is dropped from the cache', () => {
    /* Given */
    const projectsDir = makeProjectsDir();
    const folderPath = path.join(projectsDir, 'proj');
    writeSession(folderPath, '/tmp/proj');
    writeTranscript(folderPath, 'other.jsonl', {
        type: 'user',
        cwd: '/tmp/proj',
        message: {role: 'user', content: 'second'},
    });

    const {index, cached} = build(projectsDir, new Map());

    /* When */
    index.refreshFolder('proj');

    /* Then */
    assert.equal(cached.size, 2);

    /* When */
    fs.rmSync(path.join(folderPath, 'other.jsonl'));
    index.refreshFolder('proj');

    /* Then */
    assert.deepEqual([...cached.keys()], ['session'], 'the deleted transcript leaves no row behind');
});

test('a folder that disappears is forgotten entirely', () => {
    /* Given */
    const projectsDir = makeProjectsDir();
    const folderPath = path.join(projectsDir, 'proj');
    writeSession(folderPath, '/tmp/proj');
    const {index, cached} = build(projectsDir, new Map());

    /* When */
    index.refreshFolder('proj');

    /* Then */
    assert.equal(cached.size, 1);

    /* When */
    fs.rmSync(folderPath, {recursive: true});
    index.refreshFolder('proj');

    /* Then */
    assert.equal(cached.size, 0);
});

test('a folder holding only headless runs is not recorded as a project', () => {
    /* Given */
    const projectsDir = makeProjectsDir();
    writeHeadlessSession(path.join(projectsDir, 'yab-agent'), '/tmp/yab-agent');
    const meta = new Map<string, FolderMeta>();
    const {index, cached} = build(projectsDir, meta);

    /* When */
    index.reconcile();

    /* Then */
    assert.equal(cached.size, 0);
    assert.equal(meta.get('yab-agent')?.projectPath, null);
});

test('a headless run beside a coding session leaves the project listed, without the run', () => {
    /* Given */
    const projectsDir = makeProjectsDir();
    writeSession(path.join(projectsDir, 'proj'), '/tmp/proj');
    writeHeadlessSession(path.join(projectsDir, 'proj'), '/tmp/proj');
    const meta = new Map<string, FolderMeta>();
    const {index, cached} = build(projectsDir, meta);

    /* When */
    index.reconcile();

    /* Then */
    assert.deepEqual([...cached.keys()], ['session']);
    assert.equal(meta.get('proj')?.projectPath, '/tmp/proj');
});

test('a cached session whose transcript turns out headless leaves the cache', () => {
    /* Given */
    const projectsDir = makeProjectsDir();
    writeSession(path.join(projectsDir, 'proj'), '/tmp/proj');
    const {index, cached} = build(projectsDir, new Map());
    index.refreshFolder('proj');
    writeHeadlessSession(path.join(projectsDir, 'proj'), '/tmp/proj', 'session.jsonl');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(projectsDir, 'proj', 'session.jsonl'), later, later);

    /* When */
    index.refreshFolder('proj');

    /* Then */
    assert.equal(cached.size, 0);
});

import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSync} from 'esbuild';
import electronBin from 'electron';

/**
 * The VM transcript cache's table, and VM sessions in the real full-text
 * index (#292). better-sqlite3 is compiled for Electron's ABI, so these run
 * under Electron-as-Node against an in-memory database with the app's
 * schema, as task-link-store.test.ts does.
 */
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-vm-transcripts-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

buildSync({
    entryPoints: [
        path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/vm-transcript-store.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/search-index.ts'),
    ],
    outdir: work,
    format: 'cjs',
    platform: 'node',
    // The search index imports the domain's match expression: bundle it in, leave the native module out.
    bundle: true,
    external: ['better-sqlite3'],
    logLevel: 'silent',
});

/** Runs `code` with `db`, `store` and `search` on a database file; answers its JSON. */
function withDb(file: string, code: string): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteVmTranscriptStore } = require(${JSON.stringify(path.join(work, 'vm-transcript-store.js'))});
    const { SqliteSearchIndex } = require(${JSON.stringify(path.join(work, 'search-index.js'))});
    const db = new Database(${JSON.stringify(file)});
    applySchema(db);
    const store = new SqliteVmTranscriptStore(db);
    const search = new SqliteSearchIndex(db, false);
    const out = (() => { ${code} })();
    db.close();
    console.log(JSON.stringify(out ?? null));
  `,
        ],
        {cwd: APP_DIR, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8'},
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

const ENTRY = {
    sessionId: 'c1',
    hostKey: 'joris@vm.local:22',
    cwd: '/home/joris/proj',
    mtimeMs: 1000,
    transcript: {
        sessionId: 'c1',
        folder: '-home-joris-proj',
        projectPath: '/home/joris/proj',
        summary: 'Fix the parser',
        firstPrompt: 'Fix the parser please',
        created: '2026-11-02T09:00:00.000Z',
        modified: '2026-11-02T10:00:00.000Z',
        fileMtime: '2026-11-02T10:00:00.000Z',
        messageCount: 3,
        slug: null,
        aiTitle: 'Parser',
        pullRequests: [{number: 7, url: 'https://github.com/me/app/pull/7', repository: 'me/app'}],
    },
};

test('the cache is kept across opening the database again, and a put replaces', () => {
    /* Given */
    const file = path.join(work, 'persist.db');
    withDb(file, `store.put(${JSON.stringify(ENTRY)}); store.put(${JSON.stringify({...ENTRY, mtimeMs: 2000})});`);

    /* When */
    const all = withDb(file, 'return store.all();');

    /* Then */
    assert.deepEqual(all, [{...ENTRY, mtimeMs: 2000}]);
});

test('a deleted entry is gone', () => {
    /* Given */
    const file = path.join(work, 'delete.db');

    /* When */
    const all = withDb(file, `store.put(${JSON.stringify(ENTRY)}); store.delete('c1'); return store.all();`);

    /* Then */
    assert.deepEqual(all, []);
});

test("a VM session's text is found by full-text search, and survives a local folder's re-index", () => {
    /* Given */
    const entry = {
        id: 'c1',
        type: 'session',
        folder: 'vm:joris@vm.local:22',
        title: 'Parser',
        body: 'the flux capacitor',
    };

    /* When */
    const found = withDb(
        path.join(work, 'search.db'),
        `search.upsert([${JSON.stringify(entry)}]);
         search.deleteFolder('-home-joris-proj');
         return search.query('session', 'flux capa', 10, false).map((r) => r.id);`,
    );

    /* Then */
    assert.deepEqual(found, ['c1']);
});

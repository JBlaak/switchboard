import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSync} from 'esbuild';
import electronBin from 'electron';
import {HEAD, landedPr} from './support/merge-manager-fixtures';

// better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
// so the store runs under Electron-as-Node against a real database with the
// app's schema, as inbox-store.test.ts does.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-landed-store-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

buildSync({
    entryPoints: [
        path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/landed-store.ts'),
    ],
    outdir: work,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
});

/** Runs `code` against a SqliteLandedStore (as `store`, with its `db`) on a database file in `work`; answers its JSON. */
function withStore(code: string, file = ':memory:'): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteLandedStore } = require(${JSON.stringify(path.join(work, 'landed-store.js'))});
    const db = new Database(${JSON.stringify(file)});
    applySchema(db);
    const store = new SqliteLandedStore(db, () => 1);
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

const FIRST = landedPr(1, 30, 'switchboard', HEAD, {errand: 'errand-1'});
const SECOND = landedPr(
    2,
    10,
    'queue',
    {kind: 'fixing', cause: 'conflict'},
    {
        setAside: {kind: 'fixing', cause: 'conflict', reason: null, headOid: 'oid-2'},
    },
);

test('landed PRs are kept whole and survive a restart', () => {
    /* Given */
    const file = path.join(work, 'restart.db');
    withStore(`store.apply(${JSON.stringify([FIRST, SECOND])}, []);`, file);

    /* When */
    const state = withStore('return store.all();', file);

    /* Then */
    assert.deepEqual(state, [FIRST, SECOND]);
});

test('a saved PR replaces the one with its key, and removed keys go', () => {
    /* Given */
    const merged = {...FIRST, stage: {kind: 'merged', at: 5}};

    /* When */
    const state = withStore(`store.apply(${JSON.stringify([FIRST, SECOND])}, []);
    store.apply(${JSON.stringify([merged])}, [${JSON.stringify(SECOND.key)}, 'unknown']);
    return store.all();`);

    /* Then */
    assert.deepEqual(state, [merged]);
});

test('a row that is not a landed PR is skipped, not a failed launch', () => {
    /* When */
    const state = withStore(`store.apply(${JSON.stringify([FIRST])}, []);
    db.prepare("INSERT INTO landed_pull_requests (key, repository, pull_request, updated_at) VALUES ('bad', 'x', '{nope', 1)").run();
    db.prepare("INSERT INTO landed_pull_requests (key, repository, pull_request, updated_at) VALUES ('odd', 'x', '{\\"key\\":\\"odd\\"}', 1)").run();
    return store.all().map((pr) => pr.key);`);

    /* Then */
    assert.deepEqual(state, [FIRST.key]);
});

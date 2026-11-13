import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSync} from 'esbuild';
import electronBin from 'electron';
import type {FixErrand} from '../src/domain/merge-manager/errands';

// better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
// so the store runs under Electron-as-Node against a real database with the
// app's schema, as landed-store.test.ts does.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-fix-errand-store-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

buildSync({
    entryPoints: [
        path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/fix-errand-store.ts'),
    ],
    outdir: work,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
});

/** Runs `code` against a SqliteFixErrandStore (as `store`, with its `db`) on a database file in `work`; answers its JSON. */
function withStore(code: string, file = ':memory:'): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteFixErrandStore } = require(${JSON.stringify(path.join(work, 'fix-errand-store.js'))});
    const db = new Database(${JSON.stringify(file)});
    applySchema(db);
    const store = new SqliteFixErrandStore(db, () => 1);
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

const FIRST: FixErrand = {
    id: 'e1',
    key: 'movelab/connect#7',
    repository: 'movelab/connect',
    number: 7,
    branch: 'branch-7',
    lane: 'switchboard',
    cause: 'checks',
    headOid: 'oid-7',
    sessionId: 's1',
    currentId: 's1',
    worktree: '/code/connect/.claude/worktrees/errand-7-e1',
    startedAt: 10,
    finished: null,
    stoppedAt: null,
};
const SECOND: FixErrand = {
    ...FIRST,
    id: 'e2',
    sessionId: 's2',
    currentId: 's2b',
    startedAt: 20,
    finished: {outcome: 'retry', note: 'flaky', at: 30},
};

test('errands are kept whole, oldest first, and survive a restart', () => {
    /* Given */
    const file = path.join(work, 'restart.db');
    withStore(`store.save(${JSON.stringify(SECOND)}); store.save(${JSON.stringify(FIRST)});`, file);

    /* When */
    const state = withStore('return store.all();', file);

    /* Then */
    assert.deepEqual(state, [FIRST, SECOND]);
});

test('a saved errand replaces the one with its id, removed ids go, and a damaged row is skipped', () => {
    /* Given */
    const stopped = {...FIRST, stoppedAt: 15};

    /* When */
    const state = withStore(`store.save(${JSON.stringify(FIRST)}); store.save(${JSON.stringify(SECOND)});
    store.save(${JSON.stringify(stopped)});
    store.remove(['e2', 'unknown']);
    db.prepare("INSERT INTO fix_errands (id, landed_key, errand, updated_at) VALUES ('bad', 'x', '{nope', 1)").run();
    return store.all();`);

    /* Then */
    assert.deepEqual(state, [stopped]);
});

import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSync} from 'esbuild';
import electronBin from 'electron';

// better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
// so the store runs under Electron-as-Node against a real database with the
// app's schema, as task-link-store.test.ts does.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-queue-errands-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

buildSync({
    entryPoints: [
        path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/queue-errand-store.ts'),
    ],
    outdir: work,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
});

/** Runs `code` against a SqliteQueueErrandStore (as `store`) on a fresh in-memory database; answers its JSON. */
function withStore(code: string): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteQueueErrandStore } = require(${JSON.stringify(path.join(work, 'queue-errand-store.js'))});
    const db = new Database(':memory:');
    applySchema(db);
    const store = new SqliteQueueErrandStore(db);
    const out = (() => { ${code} })();
    console.log(JSON.stringify(out ?? null));
  `,
        ],
        {cwd: APP_DIR, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8'},
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

const NUDGE = {
    id: 'e1',
    kind: 'nudge',
    repository: 'o/app',
    number: 2270,
    title: 'Faster sync',
    url: 'https://github.com/o/app/pull/2270',
    reviewer: 'ann',
    message: 'Hey ann, could you review #2270 Faster sync?',
    sessionId: null,
    createdAt: 1,
    settledAt: null,
};
const FIX = {...NUDGE, id: 'e2', kind: 'fix', reviewer: null, message: null, createdAt: 2};

test('an errand is kept with its session and its settling, oldest first', () => {
    /* Given */
    const given = `store.add(${JSON.stringify(FIX)}); store.add(${JSON.stringify(NUDGE)});`;

    /* When */
    const state = withStore(`${given} store.setSession('e1', 's1'); store.settle('e1', 9);
    return store.all();`);

    /* Then */
    assert.deepEqual(state, [{...NUDGE, sessionId: 's1', settledAt: 9}, FIX]);
});

test('a removed errand is gone, and the others stay', () => {
    /* Given */
    const given = `store.add(${JSON.stringify(NUDGE)}); store.add(${JSON.stringify(FIX)});`;

    /* When */
    const state = withStore(`${given} store.remove('e1'); store.remove('unknown');
    return store.all().map(e => e.id);`);

    /* Then */
    assert.deepEqual(state, ['e2']);
});

import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSync} from 'esbuild';
import electronBin from 'electron';
import {syncSource} from '../src/domain/inbox/items';
import {NOW, THRESHOLDS, bug, issue} from './support/inbox-fixtures';

// better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
// so the store runs under Electron-as-Node against a real database with the
// app's schema, as queue-errand-store.test.ts does.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-inbox-store-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

buildSync({
    entryPoints: [
        path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/inbox-store.ts'),
    ],
    outdir: work,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
});

/** Runs `code` against a SqliteInboxStore (as `store`, with its `db`) on a fresh in-memory database; answers its JSON. */
function withStore(code: string): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteInboxStore } = require(${JSON.stringify(path.join(work, 'inbox-store.js'))});
    const db = new Database(':memory:');
    applySchema(db);
    const store = new SqliteInboxStore(db, () => 1);
    const out = (() => { ${code} })();
    console.log(JSON.stringify(out ?? null));
  `,
        ],
        {cwd: APP_DIR, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8'},
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

const CONTEXT = {now: NOW, complete: true, watchingSince: NOW, thresholds: THRESHOLDS, viewer: null};
const [BUG, ISSUE] = syncSource([], [bug('e1'), issue(7)], CONTEXT).items;
const NOTED = {...ISSUE!, notes: 'Ask Ben', state: {kind: 'snoozed', until: null}};

test('items are kept whole, state and notes included', () => {
    /* When */
    const state = withStore(`store.apply(${JSON.stringify([BUG, NOTED])}, []); return store.all();`);

    /* Then */
    assert.deepEqual(state, [BUG, NOTED]);
});

test('a saved item replaces the one with its key, and removed keys go', () => {
    /* Given */
    const read = {...BUG!, state: {kind: 'read'}};

    /* When */
    const state = withStore(`store.apply(${JSON.stringify([BUG, ISSUE])}, []);
    store.apply(${JSON.stringify([read])}, [${JSON.stringify(ISSUE!.key)}, 'unknown']);
    return store.all();`);

    /* Then */
    assert.deepEqual(state, [read]);
});

test('a row that is not an item is skipped, not a failed launch', () => {
    /* When */
    const state = withStore(`store.apply(${JSON.stringify([BUG])}, []);
    db.prepare("INSERT INTO inbox_items (key, manager, item, updated_at) VALUES ('bad', 'bug', '{nope', 1)").run();
    db.prepare("INSERT INTO inbox_items (key, manager, item, updated_at) VALUES ('odd', 'bug', '{\\"key\\":\\"odd\\"}', 1)").run();
    return store.all().map((item) => item.key);`);

    /* Then */
    assert.deepEqual(state, [BUG!.key]);
});

test('when a source was first synced is remembered', () => {
    /* When */
    const state = withStore(`const before = store.watchingSince('connect-api');
    store.setWatchingSince('connect-api', 42);
    return [before, store.watchingSince('connect-api'), store.watchingSince('movelab/connect')];`);

    /* Then */
    assert.deepEqual(state, [null, 42, null]);
});

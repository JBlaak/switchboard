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
// app's schema, as landed-store.test.ts does.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-lane-savings-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

buildSync({
    entryPoints: [
        path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/lane-savings.ts'),
    ],
    outdir: work,
    bundle: true,
    external: ['better-sqlite3'],
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
});

/** Runs `code` against a SqliteLaneSavings (as `savings`) on a fresh in-memory database; answers its JSON. */
function withSavings(code: string): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteLaneSavings } = require(${JSON.stringify(path.join(work, 'lane-savings.js'))});
    const db = new Database(':memory:');
    applySchema(db);
    const savings = new SqliteLaneSavings(db);
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

const DAY = 24 * 60 * 60 * 1000;

test('savings are summed by kind since a time, across repositories', () => {
    /* When */
    const totals = withSavings(`
    savings.add('movelab/connect', 'update-not-pushed', 3, 10 * ${DAY});
    savings.add('movelab/web', 'update-not-pushed', 2, 11 * ${DAY});
    savings.add('movelab/web', 'run-cancelled', 1, 11 * ${DAY});
    savings.add('movelab/web', 'conflict-found', 1, 2 * ${DAY});
    return savings.since(9 * ${DAY});`);

    /* Then */
    assert.deepEqual(totals, {'update-not-pushed': 5, 'run-cancelled': 1, 'conflict-found': 0});
});

test('a count that is not one, or an unknown kind, is not kept; old rows go as new ones come in', () => {
    /* When */
    const totals = withSavings(`
    savings.add('movelab/web', 'run-cancelled', 4, 1);
    savings.add('movelab/web', 'run-cancelled', 0, 40 * ${DAY});
    savings.add('movelab/web', 'run-cancelled', -2, 40 * ${DAY});
    savings.add('movelab/web', 'something-else', 2, 40 * ${DAY});
    savings.add('movelab/web', 'run-cancelled', 1, 40 * ${DAY});
    return savings.since(0);`);

    /* Then */
    assert.deepEqual(totals, {'update-not-pushed': 0, 'run-cancelled': 1, 'conflict-found': 0});
});

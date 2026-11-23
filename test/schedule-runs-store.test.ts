import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSync} from 'esbuild';
import electronBin from 'electron';
import type {ScheduleRun} from '../src/domain/schedule/manager';

// better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
// so the store runs under Electron-as-Node against a real database with the
// app's schema, as fix-errand-store.test.ts does.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-schedule-runs-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

buildSync({
    entryPoints: [
        path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
        path.join(APP_DIR, 'src/infrastructure/sqlite/schedule-runs.ts'),
    ],
    outdir: work,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
});

/** Runs `code` against a SqliteScheduleRunStore (as `store`, with its `db`) on a database file in `work`; answers its JSON. */
function withStore(code: string, file = ':memory:'): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteScheduleRunStore } = require(${JSON.stringify(path.join(work, 'schedule-runs.js'))});
    const db = new Database(${JSON.stringify(file)});
    applySchema(db);
    const store = new SqliteScheduleRunStore(db);
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

const KEY = '/code/app/.claude/commands/schedule-nightly.md';

function run(id: string, fields: Partial<ScheduleRun>): ScheduleRun {
    return {
        id,
        scheduleKey: KEY,
        sessionId: null,
        trigger: 'cron',
        dueAt: null,
        startedAt: null,
        endedAt: null,
        status: 'done',
        reason: null,
        promptVersion: 1,
        report: null,
        weekBefore: null,
        weekAfter: null,
        worktree: null,
        seen: false,
        ...fields,
    };
}

const DONE = run('r1', {
    sessionId: 's1',
    dueAt: 100,
    startedAt: 100,
    endedAt: 200,
    report: 'Did it.',
    weekBefore: 41.5,
    weekAfter: 43,
    worktree: '/code/app/.claude/worktrees/schedule-nightly-20261103-0300',
});
const MISSED = run('r2', {dueAt: 300, endedAt: 900, status: 'missed', reason: 'the Mac was asleep at 03:00'});
const RUNNING = run('r3', {trigger: 'manual', startedAt: 1000, status: 'running', promptVersion: 2});

test('runs are kept whole, newest first, and survive a restart', () => {
    /* Given */
    const file = path.join(work, 'restart.db');
    withStore(
        `[${JSON.stringify(DONE)}, ${JSON.stringify(MISSED)}, ${JSON.stringify(RUNNING)}].forEach((r) => store.add(r));`,
        file,
    );

    /* When */
    const state = withStore(
        `return {
      of: store.runsOf(${JSON.stringify(KEY)}, 10),
      two: store.runsOf(${JSON.stringify(KEY)}, 2).map((r) => r.id),
      one: store.get('r1'),
      none: store.get('nope'),
      other: store.runsOf('/elsewhere', 10),
    };`,
        file,
    );

    /* Then */
    assert.deepEqual(state, {of: [RUNNING, MISSED, DONE], two: ['r3', 'r2'], one: DONE, none: null, other: []});
});

test('an update changes only the fields it names', () => {
    /* When */
    const state = withStore(`store.add(${JSON.stringify(RUNNING)});
    store.update('r3', {status: 'failed', reason: 'exit 1: boom', endedAt: 1500, seen: true, weekAfter: 50});
    store.update('r3', {});
    return store.get('r3');`);

    /* Then */
    assert.deepEqual(state, {
        ...RUNNING,
        status: 'failed',
        reason: 'exit 1: boom',
        endedAt: 1500,
        seen: true,
        weekAfter: 50,
    });
});

test('the questions the scheduler asks: since, running, run for a time, last statuses, mark seen', () => {
    /* When */
    const state =
        withStore(`[${JSON.stringify(DONE)}, ${JSON.stringify(MISSED)}, ${JSON.stringify(RUNNING)}].forEach((r) => store.add(r));
    return {
      since: store.runsSince(250).map((r) => r.id),
      running: store.runningRuns().map((r) => r.id),
      hasDue: [store.hasRunFor(${JSON.stringify(KEY)}, 300), store.hasRunFor(${JSON.stringify(KEY)}, 301), store.hasRunFor('/x', 300)],
      last: store.lastStatuses(${JSON.stringify(KEY)}, 2),
      marked: store.markAllSeen(),
      again: store.markAllSeen(),
      seen: store.runsOf(${JSON.stringify(KEY)}, 10).map((r) => r.seen),
    };`);

    /* Then */
    assert.deepEqual(state, {
        since: ['r3', 'r2'],
        running: ['r3'],
        hasDue: [true, false, false],
        last: ['missed', 'running'],
        marked: 2,
        again: 0,
        seen: [false, true, true],
    });
});

test('a prompt is versioned from 1, a new version only when its text changes', () => {
    /* When */
    const state = withStore(`
    const a = store.versionFor(${JSON.stringify(KEY)}, 'Tidy up.', 10, 'edited outside Switchboard');
    const b = store.versionFor(${JSON.stringify(KEY)}, 'Tidy up.', 20, null);
    const c = store.versionFor(${JSON.stringify(KEY)}, 'Tidy up more.', 30, 'tighter');
    return {numbers: [a, b, c], versions: store.versionsOf(${JSON.stringify(KEY)}), other: store.versionsOf('/x')};`);

    /* Then */
    assert.deepEqual(state, {
        numbers: [1, 1, 2],
        versions: [
            {version: 2, text: 'Tidy up more.', savedAt: 30, note: 'tighter'},
            {version: 1, text: 'Tidy up.', savedAt: 10, note: 'edited outside Switchboard'},
        ],
        other: [],
    });
});

test('a renamed schedule takes its runs and versions with it', () => {
    /* Given */
    const to = '/code/app/.claude/commands/schedule-renamed.md';

    /* When */
    const state = withStore(`store.add(${JSON.stringify(DONE)});
    store.versionFor(${JSON.stringify(KEY)}, 'Tidy up.', 10, null);
    store.versionFor(${JSON.stringify(to)}, 'Stale.', 5, null);
    store.rekey(${JSON.stringify(KEY)}, ${JSON.stringify(to)});
    return {
      runs: store.runsOf(${JSON.stringify(to)}, 10).map((r) => [r.id, r.scheduleKey]),
      left: store.runsOf(${JSON.stringify(KEY)}, 10),
      versions: store.versionsOf(${JSON.stringify(to)}).map((v) => v.text),
      oldVersions: store.versionsOf(${JSON.stringify(KEY)}),
    };`);

    /* Then */
    assert.deepEqual(state, {runs: [['r1', to]], left: [], versions: ['Tidy up.'], oldVersions: []});
});

import {after, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP_DIR = path.join(__dirname, '..');
// better-sqlite3 is compiled for Electron's ABI, so plain `node` cannot load
// it (or database.js). Run every DB-touching snippet under Electron-as-Node instead.
// Under plain node, require('electron') returns the path to the binary.
// The typings model `electron` as the module the main process gets; under plain
// node it is the path to the binary, which is what execFile needs.
import electronBin from 'electron';
const ELECTRON: string = electronBin as unknown as string;

/**
 * Async, so the scenarios below can run side by side: each one waits on several
 * Electron starts in a row, which made this one of the slowest files when they
 * ran one after another.
 */
function runInElectronNode(
    code: string,
    dataDir: string,
): Promise<{status: number | null; stdout: string; stderr: string}> {
    return new Promise((resolve) => {
        execFile(
            ELECTRON,
            ['-e', code],
            {
                cwd: APP_DIR,
                env: {...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir},
                encoding: 'utf8',
            },
            (error, stdout, stderr) => {
                const code = (error as (NodeJS.ErrnoException & {code?: unknown}) | null)?.code;
                resolve({status: error ? (typeof code === 'number' ? code : null) : 0, stdout, stderr});
            },
        );
    });
}

// Opening the database applies the schema, so each scenario does it in a fresh
// child process pointed at an isolated data dir. It is the *built* module that
// runs here (scripts/build.mjs emits app/database.js for exactly this):
// better-sqlite3 needs Electron's ABI, so the snippet cannot go through tsx.
const BUILT_DB = path.join(APP_DIR, 'app', 'database.js');

async function openDatabase(dataDir: string) {
    assert.ok(fs.existsSync(BUILT_DB), `${BUILT_DB} is missing — run \`npm run build\` before the tests`);
    return runInElectronNode(`require(${JSON.stringify(BUILT_DB)}).openDatabase().close()`, dataDir);
}

async function inspectDb(dataDir: string) {
    const r = await runInElectronNode(
        `
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    console.log(JSON.stringify({
      cols: db.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name),
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
      metaCount: db.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n,
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
    }));
  `,
        dataDir,
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
}

const dataDirs: string[] = [];
after(() => {
    for (const dir of dataDirs) fs.rmSync(dir, {recursive: true, force: true});
});

/** An isolated, empty data dir, removed once the file's tests are done. */
function dataDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dataDirs.push(dir);
    return dir;
}

/** Run a snippet against the data dir's database (as `db`), failing on a non-zero exit; answers its last line. */
async function sqlite(dataDir: string, code: string, readonly = false): Promise<string> {
    const r = await runInElectronNode(
        `
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db')${readonly ? ', { readonly: true }' : ''});
    ${code}
  `,
        dataDir,
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim().split('\n').pop() ?? '';
}

/** Open the database as a step towards the scenario, failing if that open fails. */
async function opened(dataDir: string): Promise<void> {
    const r = await openDatabase(dataDir);
    assert.equal(r.status, 0, r.stderr);
}

// Every scenario has its own data dir, so they run side by side.
describe('schema reconcile', {concurrency: true}, () => {
    // Regression: a DB migrated to db_version 5 by a parallel branch (different
    // v4/v5 migrations, extra columns, no fileMtime) skips this branch's
    // version-numbered migrations entirely. Startup must still add fileMtime and
    // clear the stale cache instead of crashing at prepare().
    test('foreign higher-version database is reconciled, not crashed', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-foreign-');
        await sqlite(
            dir,
            `
    db.exec(\`CREATE TABLE session_cache (
      sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
      summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
      messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT,
      parentSessionId TEXT, agentId TEXT, subagentType TEXT,
      description TEXT, runtime TEXT DEFAULT 'claude', sessionFile TEXT
    )\`);
    db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '5')").run();
    db.prepare("INSERT INTO session_cache (sessionId, folder, modified) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z')").run();
    db.prepare("INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('f1', 123)").run();
  `,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        const state = await inspectDb(dir);
        assert.ok(state.cols.includes('fileMtime'), 'fileMtime column added');
        assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
        assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
        assert.equal(state.version, '5', 'foreign db_version not downgraded');
        for (const col of ['parentSessionId', 'agentId', 'runtime', 'sessionFile']) {
            assert.ok(state.cols.includes(col), `foreign column ${col} preserved`);
        }
    });

    /** A v4 cache from before pullRequests existed, holding one session and its folder gate. */
    const CACHE_WITHOUT_PULL_REQUESTS = `
  db.exec(\`CREATE TABLE session_cache (
    sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
    summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
    messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT, fileMtime TEXT
  )\`);
  db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '4')").run();
  db.prepare("INSERT INTO session_cache (sessionId, folder, modified, fileMtime) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')").run();
  db.prepare("INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('f1', 123)").run();
`;

    // A cache written before pullRequests existed holds rows that would read as
    // "no PRs" until their transcript next changes. The column's arrival clears the
    // cache and the folder gate so the cold-start rebuild re-reads every session.
    test('a cache without pullRequests gains the column and is cleared for re-index', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-prs-');
        await sqlite(dir, CACHE_WITHOUT_PULL_REQUESTS);

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        const state = await inspectDb(dir);
        assert.ok(state.cols.includes('pullRequests'), 'pullRequests column added');
        assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
        assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
    });

    test('the pullRequests re-index happens only once', async () => {
        // Only once: a second open finds the column and leaves the cache alone.
        /* Given */
        const dir = dataDir('switchboard-db-prs-once-');
        await sqlite(dir, CACHE_WITHOUT_PULL_REQUESTS);
        await opened(dir);
        await sqlite(
            dir,
            `db.prepare("INSERT INTO session_cache (sessionId, folder, pullRequests) VALUES ('s1', 'f1', '[]')").run();`,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0);
        assert.equal((await inspectDb(dir)).cacheCount, 1, 'cache kept once the column exists');
    });

    async function sessionActionColumns(dataDir: string): Promise<string[]> {
        const r = await runInElectronNode(
            `
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    console.log(JSON.stringify(db.prepare('PRAGMA table_info(session_actions)').all().map(c => c.name)));
  `,
            dataDir,
        );
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]');
    }

    const SESSION_ACTION_COLUMNS = [
        'id',
        'session',
        'repository',
        'item_key',
        'action',
        'origin',
        'phase',
        'prompt',
        'queued_at',
        'sent_at',
        'done_at',
        'details',
    ];

    /** A database a parallel branch migrated past this one's version, with nothing else in it. */
    const FOREIGN_V9 = `
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '9')").run();
`;

    const QUEUE_ONE_ACTION = `
  db.prepare(\`INSERT INTO session_actions (id, session, item_key, action, origin, phase, prompt, queued_at)
    VALUES ('a1', 's1', 'pr:x', 'ship', 'manual', 'queued', 'Ship PR #1', '2026-01-01T00:00:00Z')\`).run();
`;

    // One fresh open answers for every column and table the schema adds, rather
    // than an Electron start per addition.
    test('a fresh database gets fileMtime, pullRequests and the session_actions table', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-fresh-');

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        const {cols} = await inspectDb(dir);
        assert.ok(cols.includes('fileMtime'));
        assert.ok(cols.includes('pullRequests'));
        assert.deepEqual(await sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
    });

    // The Session work queue must survive a restart, so its table is created on
    // every database, including one a parallel branch migrated past this one's
    // version: a numbered migration would be skipped there.
    test('an existing, foreign higher-version database gains session_actions', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-actions-foreign-');
        await sqlite(dir, FOREIGN_V9);

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0);
        assert.deepEqual(await sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
    });

    test('an existing, foreign higher-version database keeps its session_actions rows across opens', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-actions-foreign-rows-');
        await sqlite(dir, FOREIGN_V9);
        await opened(dir);
        await sqlite(dir, QUEUE_ONE_ACTION);

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0);
        const count = await sqlite(
            dir,
            `console.log(String(db.prepare('SELECT COUNT(*) AS n FROM session_actions').get().n));`,
            true,
        );
        assert.equal(count, '1', 'a queued action survives the next open');
    });

    test('a session_actions table from before card details gains the column, and keeps its rows', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-actions-details-');
        await sqlite(
            dir,
            `
    db.exec(\`CREATE TABLE session_actions (id TEXT PRIMARY KEY, session TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '',
      item_key TEXT NOT NULL, action TEXT NOT NULL, origin TEXT NOT NULL, phase TEXT NOT NULL, prompt TEXT NOT NULL,
      queued_at TEXT NOT NULL, sent_at TEXT, done_at TEXT)\`);
    ${QUEUE_ONE_ACTION}
  `,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0);
        assert.deepEqual(await sessionActionColumns(dir), SESSION_ACTION_COLUMNS);
    });

    // The auto-fix limit survives a restart only if its history does (W3).
    test('the auto-fix history table is created, and its rows survive the next open', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-auto-fix-');
        await opened(dir);
        await sqlite(
            dir,
            `
    db.prepare(\`INSERT INTO auto_fix_attempts (kind, repository, number, check_name, head_sha, origin, activity_id, at)
      VALUES ('attempt', 'o/app', 7, 'test', 'aaa', 'auto', 'a1', '2026-01-01T00:00:00Z')\`).run();
  `,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0);
        const rows = await sqlite(
            dir,
            `console.log(JSON.stringify(db.prepare('SELECT kind, head_sha FROM auto_fix_attempts').all()));`,
            true,
        );
        assert.deepEqual(JSON.parse(rows || '[]'), [{kind: 'attempt', head_sha: 'aaa'}]);
    });

    test('a session_meta table from before snoozing gains snoozedUntil, and keeps its rows', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-snooze-');
        await sqlite(
            dir,
            `
    db.exec('CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)');
    db.prepare("INSERT INTO session_meta (sessionId, name) VALUES ('s1', 'Kept')").run();
  `,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        const row = JSON.parse(
            await sqlite(
                dir,
                `console.log(JSON.stringify(db.prepare("SELECT * FROM session_meta WHERE sessionId = 's1'").get()))`,
                true,
            ),
        );
        assert.deepEqual(row, {
            sessionId: 's1',
            name: 'Kept',
            starred: 0,
            archived: 0,
            pinPosition: null,
            snoozedUntil: null,
        });
    });

    // The enrolled phones (#194) must be there on every database, including one a
    // parallel branch migrated past this one's version.
    test('a foreign higher-version database gains phone_devices, and its rows survive the next open', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-phone-devices-');
        await sqlite(dir, FOREIGN_V9);
        await opened(dir);
        await sqlite(
            dir,
            `
    db.prepare(\`INSERT INTO phone_devices (id, name, fingerprint, paired_at, last_seen_at)
      VALUES ('d1', 'Pixel 9 Pro', 'aa', 1700000000000, NULL)\`).run();
  `,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        const state = JSON.parse(
            await sqlite(
                dir,
                `console.log(JSON.stringify({
    cols: db.prepare('PRAGMA table_info(phone_devices)').all().map(c => c.name),
    rows: db.prepare('SELECT id FROM phone_devices').all(),
  }));`,
                true,
            ),
        );
        assert.deepEqual(state, {
            cols: ['id', 'name', 'fingerprint', 'paired_at', 'last_seen_at'],
            rows: [{id: 'd1'}],
        });
    });

    // Which session works on which task (#245) must be there on every database,
    // including one a parallel branch migrated past this one's version.
    test('a foreign higher-version database gains task_links and task_unlinks, and their rows survive the next open', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-task-links-');
        await sqlite(dir, FOREIGN_V9);
        await opened(dir);
        await sqlite(
            dir,
            `
    db.prepare(\`INSERT INTO task_links (task_id, project_path, session_id, source, linked_at)
      VALUES ('1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9', '/code/app', 's1', 'start', 1700000000000)\`).run();
    db.prepare("INSERT INTO task_unlinks (session_id, unlinked_at) VALUES ('s2', 1700000000000)").run();
  `,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        const state = JSON.parse(
            await sqlite(
                dir,
                `console.log(JSON.stringify({
    cols: db.prepare('PRAGMA table_info(task_links)').all().map(c => c.name),
    rows: db.prepare('SELECT session_id FROM task_links').all(),
    unlinkCols: db.prepare('PRAGMA table_info(task_unlinks)').all().map(c => c.name),
    unlinks: db.prepare('SELECT session_id FROM task_unlinks').all(),
  }));`,
                true,
            ),
        );
        assert.deepEqual(state, {
            cols: ['id', 'task_id', 'project_path', 'session_id', 'source', 'linked_at'],
            rows: [{session_id: 's1'}],
            unlinkCols: ['session_id', 'unlinked_at'],
            unlinks: [{session_id: 's2'}],
        });
    });

    /**
     * Pins stored before positions existed (#379): two pinned sessions and
     * one not, two pinned projects, and two slug plans and a GitHub plan.
     */
    const PINS_WITHOUT_POSITIONS = `
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '5')").run();
  db.exec(\`CREATE TABLE session_cache (
    sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
    summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
    messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT, fileMtime TEXT, pullRequests TEXT
  )\`);
  db.exec('CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, snoozedUntil TEXT)');
  db.exec('CREATE TABLE pinned_projects (project_path TEXT PRIMARY KEY, pinned_at INTEGER NOT NULL)');
  db.exec('CREATE TABLE pinned_plans (project_path TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (project_path, slug))');
  db.exec(\`CREATE TABLE pinned_issue_plans (project_path TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
    title TEXT NOT NULL, pinned_at INTEGER NOT NULL, PRIMARY KEY (project_path, repository, number))\`);
  const cache = db.prepare("INSERT INTO session_cache (sessionId, folder, projectPath, modified, slug) VALUES (?, 'f', '/app', ?, ?)");
  cache.run('old', '2026-01-01T00:00:00.000Z', null);
  cache.run('new', '2026-03-01T00:00:00.000Z', null);
  cache.run('plain', '2026-04-01T00:00:00.000Z', null);
  cache.run('quiet-plan', '2026-01-15T00:00:00.000Z', 'quiet');
  cache.run('busy-plan', '2026-02-15T00:00:00.000Z', 'busy');
  const meta = db.prepare('INSERT INTO session_meta (sessionId, starred) VALUES (?, ?)');
  meta.run('old', 1);
  meta.run('new', 1);
  meta.run('plain', 0);
  const project = db.prepare('INSERT INTO pinned_projects (project_path, pinned_at) VALUES (?, ?)');
  project.run('/first-pinned', 1000);
  project.run('/last-pinned', 2000);
  const plan = db.prepare('INSERT INTO pinned_plans (project_path, slug) VALUES (?, ?)');
  plan.run('/app', 'quiet');
  plan.run('/app', 'busy');
  db.prepare("INSERT INTO pinned_issue_plans VALUES ('/app', 'o/app', 7, 'Epic', ?)").run(Date.parse('2026-02-01T00:00:00.000Z'));
`;

    /** Every pin's position, by what it pins. */
    const PIN_POSITIONS = `console.log(JSON.stringify({
    sessions: db.prepare('SELECT sessionId, pinPosition FROM session_meta ORDER BY sessionId').all(),
    projects: db.prepare('SELECT project_path, position FROM pinned_projects ORDER BY project_path').all(),
    plans: db.prepare('SELECT slug, position FROM pinned_plans ORDER BY slug').all(),
    issuePlans: db.prepare('SELECT number, position FROM pinned_issue_plans').all(),
  }));`;

    // Each pinned section keeps the order it showed: Pinned by newest activity,
    // Pinned projects newest pin first, Pinned plans (both kinds together) by a
    // slug plan's newest session and a GitHub plan's pin time, newest first.
    test('pins from before positions get the positions of the order they showed', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-pin-positions-');
        await sqlite(dir, PINS_WITHOUT_POSITIONS);

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(await sqlite(dir, PIN_POSITIONS, true)), {
            sessions: [
                {sessionId: 'new', pinPosition: 0},
                {sessionId: 'old', pinPosition: 1},
                {sessionId: 'plain', pinPosition: null},
            ],
            projects: [
                {project_path: '/first-pinned', position: 1},
                {project_path: '/last-pinned', position: 0},
            ],
            plans: [
                {slug: 'busy', position: 0},
                {slug: 'quiet', position: 2},
            ],
            issuePlans: [{number: 7, position: 1}],
        });
    });

    test('positions are filled in only once: a later open keeps a reordered section', async () => {
        /* Given */
        const dir = dataDir('switchboard-db-pin-positions-once-');
        await sqlite(dir, PINS_WITHOUT_POSITIONS);
        await opened(dir);
        await sqlite(
            dir,
            `db.prepare("UPDATE session_meta SET pinPosition = CASE sessionId WHEN 'old' THEN 0 ELSE 1 END WHERE starred = 1").run();`,
        );

        /* When */
        const r = await openDatabase(dir);

        /* Then */
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(JSON.parse(await sqlite(dir, PIN_POSITIONS, true)).sessions, [
            {sessionId: 'new', pinPosition: 1},
            {sessionId: 'old', pinPosition: 0},
            {sessionId: 'plain', pinPosition: null},
        ]);
    });
});

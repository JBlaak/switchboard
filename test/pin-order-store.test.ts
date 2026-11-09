/**
 * Pinning, unpinning and moving pins through the service, stored by the
 * SQLite repository (#379): a new pin goes to the end, unpinning drops the
 * position, and a move is what the next read answers.
 *
 * better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
 * so this runs under Electron-as-Node against an in-memory database with the
 * app's schema, as task-link-store.test.ts does.
 */
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSync} from 'esbuild';
import electronBin from 'electron';

const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-pin-order-'));
after(() => fs.rmSync(work, {recursive: true, force: true}));

const BUNDLE = path.join(work, 'pins.js');
buildSync({
    stdin: {
        contents: `
            export {applySchema} from './src/infrastructure/sqlite/schema';
            export {SqliteSessionRepository} from './src/infrastructure/sqlite/session-repository';
            export {PinOrderService} from './src/application/services/pin-order-service';
        `,
        resolveDir: APP_DIR,
        loader: 'ts',
    },
    bundle: true,
    external: ['better-sqlite3'],
    outfile: BUNDLE,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
});

/**
 * Runs `code` with `repo` (the repository) and `pins` (the service) on a fresh
 * in-memory database, after `seed` (raw SQL against `db`); answers its JSON.
 */
function withPins(seed: string, code: string): unknown {
    const r = spawnSync(
        ELECTRON,
        [
            '-e',
            `
    const Database = require('better-sqlite3');
    const { applySchema, SqliteSessionRepository, PinOrderService } = require(${JSON.stringify(BUNDLE)});
    const db = new Database(':memory:');
    applySchema(db);
    ${seed}
    const repo = new SqliteSessionRepository(db);
    const pins = new PinOrderService(repo);
    const out = (() => { ${code} })();
    console.log(JSON.stringify(out ?? null));
  `,
        ],
        {cwd: APP_DIR, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, encoding: 'utf8'},
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

const session = (sessionId: string) => ({kind: 'session', sessionId});

/** Two pinned sessions from before positions existed: `new` more recently active than `old`. */
const TWO_UNPLACED_PINS = `
    const cache = db.prepare("INSERT INTO session_cache (sessionId, folder, projectPath, modified) VALUES (?, 'f', '/app', ?)");
    cache.run('old', '2026-01-01T00:00:00.000Z');
    cache.run('new', '2026-02-01T00:00:00.000Z');
    db.prepare("INSERT INTO session_meta (sessionId, starred) VALUES ('old', 1), ('new', 1)").run();
`;

const toggleStar = (id: string) =>
    `pins.toggle('sessions', {kind: 'session', sessionId: '${id}'}, () => repo.toggleStar('${id}'), (s) => s === 1)`;

test('a new pin lands at the end, after the pins it found in their old order', () => {
    /* Given */
    const seed = TWO_UNPLACED_PINS;

    /* When */
    const result = withPins(seed, `return ${toggleStar('fresh')};`);

    /* Then */
    assert.deepEqual(result, {result: 1, order: [session('new'), session('old'), session('fresh')]});
});

test('unpinning drops the position, and the rest keep their order', () => {
    /* Given */
    const seed =
        TWO_UNPLACED_PINS + `db.prepare("INSERT INTO session_meta (sessionId, starred) VALUES ('third', 1)").run();`;

    /* When */
    const result = withPins(
        seed,
        `
        ${toggleStar('new')};
        return {order: repo.getPinOrder('sessions'), meta: repo.getMeta('new')};
    `,
    ) as {order: unknown; meta: {starred: number; pinPosition: number | null}};

    /* Then */
    assert.deepEqual(result.order, [session('old'), session('third')]);
    assert.equal(result.meta.starred, 0);
    assert.equal(result.meta.pinPosition, null);
});

test('a move is what the next read of the section answers', () => {
    /* Given */
    const seed = TWO_UNPLACED_PINS;

    /* When */
    const result = withPins(
        seed,
        `
        pins.move('sessions', [{kind: 'session', sessionId: 'old'}], {before: {kind: 'session', sessionId: 'new'}});
        return new SqliteSessionRepository(db).getPinOrder('sessions');
    `,
    );

    /* Then */
    assert.deepEqual(result, [session('old'), session('new')]);
});

test('pinned projects and both kinds of pinned plan keep their own orders', () => {
    /* Given */
    const seed = `
        db.prepare("INSERT INTO pinned_projects (project_path, pinned_at) VALUES ('/a', 1), ('/b', 2)").run();
        db.prepare("INSERT INTO pinned_plans (project_path, slug) VALUES ('/a', 'slug')").run();
        db.prepare("INSERT INTO pinned_issue_plans (project_path, repository, number, title, pinned_at) VALUES ('/b', 'o/r', 7, 'Epic', 1)").run();
    `;

    /* When */
    const result = withPins(
        seed,
        `
        pins.move('projects', [{kind: 'project', projectPath: '/a'}], {before: {kind: 'project', projectPath: '/b'}});
        pins.move('plans', [{kind: 'issuePlan', projectPath: '/b', repository: 'o/r', number: 7}], {before: {kind: 'plan', projectPath: '/a', slug: 'slug'}});
        return {
            projects: repo.getPinnedProjects().map((p) => [p.projectPath, p.position]),
            plans: repo.getPinOrder('plans'),
            issuePosition: repo.getPinnedIssuePlans()[0].position,
        };
    `,
    );

    /* Then */
    assert.deepEqual(result, {
        projects: [
            ['/a', 0],
            ['/b', 1],
        ],
        plans: [
            {kind: 'issuePlan', projectPath: '/b', repository: 'o/r', number: 7},
            {kind: 'plan', projectPath: '/a', slug: 'slug'},
        ],
        issuePosition: 0,
    });
});

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import electronBin from 'electron';

// better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
// so the store runs under Electron-as-Node against a real database with the
// app's schema, as phone-device-registry.test.ts does.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-task-links-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

buildSync({
  entryPoints: [
    path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
    path.join(APP_DIR, 'src/infrastructure/sqlite/task-link-store.ts'),
  ],
  outdir: work,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});

/** Runs `code` against a SqliteTaskLinkStore (as `store`) on a fresh in-memory database; answers its JSON. */
function withStore(code: string): unknown {
  const r = spawnSync(ELECTRON, ['-e', `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteTaskLinkStore } = require(${JSON.stringify(path.join(work, 'task-link-store.js'))});
    const db = new Database(':memory:');
    applySchema(db);
    const store = new SqliteTaskLinkStore(db);
    const out = (() => { ${code} })();
    console.log(JSON.stringify(out ?? null));
  `], { cwd: APP_DIR, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

const TASK = '1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const link = (taskId: string, sessionId: string, linkedAt: number, source = 'start') =>
  `store.link(${JSON.stringify({ taskId, projectPath: '/code/app', sessionId, source, linkedAt })});`;

test('a session keeps one link: a newer one replaces it', () => {
  /* Given */
  const given = link(TASK, 's1', 1) + link(TASK, 's2', 2);

  /* When */
  const state = withStore(`${given} ${link(OTHER, 's1', 3, 'manual')}
    return { all: store.all(), s1: store.forSession('s1'), task: store.forTask(${JSON.stringify(TASK)}) };`);

  /* Then */
  assert.deepEqual(state, {
    all: [
      { taskId: TASK, projectPath: '/code/app', sessionId: 's2', source: 'start', linkedAt: 2 },
      { taskId: OTHER, projectPath: '/code/app', sessionId: 's1', source: 'manual', linkedAt: 3 },
    ],
    s1: { taskId: OTHER, projectPath: '/code/app', sessionId: 's1', source: 'manual', linkedAt: 3 },
    task: [{ taskId: TASK, projectPath: '/code/app', sessionId: 's2', source: 'start', linkedAt: 2 }],
  });
});

test('unlinking drops the session\'s link and nothing else', () => {
  /* Given */
  const given = link(TASK, 's1', 1) + link(TASK, 's2', 2);

  /* When */
  const state = withStore(`${given} store.unlink('s1', 5);
    return { s1: store.forSession('s1'), all: store.all().map(l => l.sessionId), unlinkedAt: store.unlinkedAt('s1') };`);

  /* Then */
  assert.deepEqual(state, { s1: null, all: ['s2'], unlinkedAt: 5 });
});

test('an unlink is remembered until the session is linked again', () => {
  /* Given */
  const given = link(TASK, 's1', 1) + `store.unlink('s1', 5); store.unlink('s1', 7);`;

  /* When */
  const state = withStore(`${given}
    const before = store.unlinkedAt('s1');
    ${link(OTHER, 's1', 9)}
    return { before, after: store.unlinkedAt('s1'), never: store.unlinkedAt('s2') };`);

  /* Then */
  assert.deepEqual(state, { before: 7, after: null, never: null });
});

test('a repo set by hand is one row without a session, replaced by the next', () => {
  /* Given */
  const given = link(TASK, 's1', 1);

  /* When */
  const state = withStore(`${given}
    store.setRepo(${JSON.stringify(TASK)}, '/code/first', 2);
    store.setRepo(${JSON.stringify(TASK)}, '/code/second', 3);
    return store.forTask(${JSON.stringify(TASK)});`);

  /* Then */
  assert.deepEqual(state, [
    { taskId: TASK, projectPath: '/code/app', sessionId: 's1', source: 'start', linkedAt: 1 },
    { taskId: TASK, projectPath: '/code/second', sessionId: null, source: 'manual', linkedAt: 3 },
  ]);
});

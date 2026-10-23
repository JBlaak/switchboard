import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import electronBin from 'electron';
import type { EnrolledDevice } from '../src/application/ports/phone-access';

// better-sqlite3 is compiled for Electron's ABI (see db-schema-reconcile.test.ts),
// so the registry runs under Electron-as-Node against a real database with the
// app's schema. Both modules import only types, so a plain per-file transpile
// to CommonJS is all they need to load there.
const APP_DIR = path.join(__dirname, '..');
const ELECTRON: string = electronBin as unknown as string;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-phone-registry-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

buildSync({
  entryPoints: [
    path.join(APP_DIR, 'src/infrastructure/sqlite/schema.ts'),
    path.join(APP_DIR, 'src/infrastructure/sqlite/device-registry.ts'),
  ],
  outdir: work,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});

/**
 * Runs `code` against a SqliteDeviceRegistry (as `registry`) on a fresh
 * in-memory database, and answers what it printed as JSON on its last line.
 */
function withRegistry(code: string): unknown {
  const r = spawnSync(ELECTRON, ['-e', `
    const Database = require('better-sqlite3');
    const { applySchema } = require(${JSON.stringify(path.join(work, 'schema.js'))});
    const { SqliteDeviceRegistry } = require(${JSON.stringify(path.join(work, 'device-registry.js'))});
    const db = new Database(':memory:');
    applySchema(db);
    const registry = new SqliteDeviceRegistry(db);
    const out = (() => { ${code} })();
    console.log(JSON.stringify(out ?? null));
  `], { cwd: APP_DIR, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? 'null');
}

const PIXEL: EnrolledDevice = {
  id: 'd1', name: 'Pixel 9 Pro', fingerprint: 'a'.repeat(64), pairedAt: 1_700_000_000_000, lastSeenAt: null,
};
const TABLET: EnrolledDevice = {
  id: 'd2', name: 'Galaxy Tab', fingerprint: 'b'.repeat(64), pairedAt: 1_700_000_100_000, lastSeenAt: 1_700_000_200_000,
};

const add = (...devices: EnrolledDevice[]) =>
  devices.map(d => `registry.add(${JSON.stringify(d)});`).join('\n');

test('an added device is listed and found by its fingerprint', () => {
  /* Given */
  const setup = add(PIXEL, TABLET);

  /* When */
  const result = withRegistry(`${setup}
    return { list: registry.list(), found: registry.findByFingerprint(${JSON.stringify(TABLET.fingerprint)}) };`);

  /* Then */
  assert.deepEqual(result, { list: [PIXEL, TABLET], found: TABLET });
});

test('an unknown fingerprint finds nothing', () => {
  /* Given */
  const setup = add(PIXEL);

  /* When */
  const found = withRegistry(`${setup} return registry.findByFingerprint('${'c'.repeat(64)}');`);

  /* Then */
  assert.equal(found, null);
});

test('touch records when a device was last seen', () => {
  /* Given */
  const setup = add(PIXEL, TABLET);

  /* When */
  const list = withRegistry(`${setup} registry.touch('d1', 1_800_000_000_000); return registry.list();`);

  /* Then */
  assert.deepEqual(list, [{ ...PIXEL, lastSeenAt: 1_800_000_000_000 }, TABLET]);
});

test('remove takes one device out', () => {
  /* Given */
  const setup = add(PIXEL, TABLET);

  /* When */
  const list = withRegistry(`${setup} registry.remove('d1'); return registry.list();`);

  /* Then */
  assert.deepEqual(list, [TABLET]);
});

test('clear takes every device out', () => {
  /* Given */
  const setup = add(PIXEL, TABLET);

  /* When */
  const list = withRegistry(`${setup} registry.clear(); return registry.list();`);

  /* Then */
  assert.deepEqual(list, []);
});

test('a second device with an enrolled fingerprint is refused', () => {
  /* Given */
  const setup = add(PIXEL);
  const twin = { ...TABLET, fingerprint: PIXEL.fingerprint };

  /* When */
  const result = withRegistry(`${setup}
    let error = null;
    try { registry.add(${JSON.stringify(twin)}); } catch (e) { error = e.code; }
    return { error, list: registry.list() };`);

  /* Then */
  assert.deepEqual(result, { error: 'SQLITE_CONSTRAINT_UNIQUE', list: [PIXEL] });
});

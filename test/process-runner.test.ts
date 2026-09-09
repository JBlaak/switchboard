import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

import { NodeProcessRunner } from '../src/infrastructure/process/node-process-runner';
import { fakeFileSystem } from './support/fakes';

/**
 * The real adapter, driven with the one executable every test machine has:
 * this Node. Each case is a `-e` script, so nothing here depends on git, a
 * shell, or the platform's coreutils.
 *
 * The contract under test is the one the port promises: everything the process
 * produced comes back, whatever its exit code, and only a process that never
 * ran or had to be killed is a rejection.
 */

const node = process.execPath;

/** The host's environment, minus the undefined entries the type allows. */
function hostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** A runner on the host's own environment — a bare one cannot start node on Windows. */
const runner = (): NodeProcessRunner => new NodeProcessRunner({ baseEnv: hostEnv() });

test('captures stdout of a process that exits cleanly', async () => {
  const result = await runner().exec(node, ['-e', "process.stdout.write('hello')"], { timeoutMs: 10_000 });
  assert.deepEqual(result, { stdout: 'hello', stderr: '', code: 0 });
});

test('captures stderr alongside stdout', async () => {
  const result = await runner().exec(
    node,
    ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
    { timeoutMs: 10_000 },
  );
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.code, 0);
});

test('a non-zero exit resolves with the code and the output intact', async () => {
  const result = await runner().exec(
    node,
    ['-e', "process.stdout.write('not ignored'); process.stderr.write('warning'); process.exit(3)"],
    { timeoutMs: 10_000 },
  );
  assert.equal(result.code, 3);
  assert.equal(result.stdout, 'not ignored');
  assert.equal(result.stderr, 'warning');
});

test('stdin is delivered to the child and closed', async () => {
  const echoUpper = "let s = ''; process.stdin.setEncoding('utf8');"
    + " process.stdin.on('data', c => { s += c; });"
    + " process.stdin.on('end', () => process.stdout.write(s.toUpperCase()))";
  const result = await runner().exec(node, ['-e', echoUpper], { timeoutMs: 10_000, stdin: 'echo me' });
  assert.equal(result.stdout, 'ECHO ME');
  assert.equal(result.code, 0);
});

test('a child that reads stdin without being given any sees EOF instead of hanging', async () => {
  const drain = "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'))";
  const result = await runner().exec(node, ['-e', drain], { timeoutMs: 10_000 });
  assert.equal(result.stdout, 'eof');
});

test('runs in the requested cwd with the base environment, extras laid on top', async () => {
  const cwd = fs.realpathSync(os.tmpdir());
  const processes = new NodeProcessRunner({
    baseEnv: { ...hostEnv(), SWITCHBOARD_TEST_BASE: 'base', SWITCHBOARD_TEST_EXTRA: 'from-base' },
  });
  const report = "process.stdout.write(JSON.stringify({"
    + " cwd: process.cwd(),"
    + " base: process.env.SWITCHBOARD_TEST_BASE,"
    + " extra: process.env.SWITCHBOARD_TEST_EXTRA,"
    + " color: process.env.FORCE_COLOR }))";
  const result = await processes.exec(node, ['-e', report], {
    cwd,
    timeoutMs: 10_000,
    env: { SWITCHBOARD_TEST_EXTRA: 'from-opts' },
  });
  assert.deepEqual(JSON.parse(result.stdout), {
    cwd,
    base: 'base',
    extra: 'from-opts',
    // headlessEnv: a one-shot command's output is parsed, not shown.
    color: '0',
  });
});

test('a file that does not exist rejects, naming the file', async () => {
  const missing = '/definitely/not/a/binary/switchboard-process-runner-test';
  await assert.rejects(
    runner().exec(missing, ['--version'], { timeoutMs: 10_000 }),
    (err: Error) => err.message.includes(missing) && /could not be started/.test(err.message),
  );
});

test('a process that outlives its timeout is killed and rejects', async () => {
  await assert.rejects(
    runner().exec(node, ['-e', 'setTimeout(() => {}, 60_000)'], { timeoutMs: 200 }),
    (err: Error) => err.message.includes(node) && /200ms/.test(err.message),
  );
});

// ── The in-memory filesystem the other tests lean on ──

test('fakeFileSystem lists the direct children of a directory, typed', () => {
  const disk = fakeFileSystem({
    files: {
      '/repo/README.md': '# hi',
      '/repo/src/index.ts': '',
      '/repo/src/deep/nested.ts': '',
    },
    dirs: ['/repo/empty'],
  });

  assert.deepEqual(disk.readDir('/repo'), [
    { name: 'README.md', isFile: true, isDirectory: false },
    { name: 'empty', isFile: false, isDirectory: true },
    { name: 'src', isFile: false, isDirectory: true },
  ]);
  assert.deepEqual(disk.readDir('/repo/empty'), []);
  assert.ok(disk.isDirectory('/repo/src/deep'), 'seeding a file creates its ancestors');
  assert.throws(() => disk.readDir('/repo/nowhere'), /ENOENT/);
});

test('fakeFileSystem reads what was seeded or written, and throws like the real one', () => {
  const disk = fakeFileSystem({ files: { '/home/test/.claude/settings.json': '{}' } });

  assert.equal(disk.readText('/home/test/.claude/settings.json'), '{}');
  assert.equal(disk.readText('.claude/settings.json'), '{}', 'relative paths resolve against homeDir');
  assert.throws(() => disk.readText('/home/test/.claude/missing.json'), /ENOENT/);
  assert.equal(disk.stat('/home/test/.claude/missing.json'), null);
  assert.equal(disk.stat('/home/test/.claude/settings.json')?.size, 2);

  assert.throws(() => disk.writeText('/home/test/never-made/file.txt', 'x'), /ENOENT/);
  disk.makeDir('/home/test/never-made');
  disk.writeText('/home/test/never-made/file.txt', 'x');
  assert.deepEqual(disk.writes, [['/home/test/never-made/file.txt', 'x']]);
  assert.equal(disk.readText('/home/test/never-made/file.txt'), 'x');
});

test('fakeFileSystem isInside follows the real adapter: equal, child, not a sibling with a shared prefix', () => {
  const disk = fakeFileSystem();
  assert.equal(disk.isInside('/repo', '/repo'), true);
  assert.equal(disk.isInside('/repo', '/repo/src/index.ts'), true);
  assert.equal(disk.isInside('/repo/', '/repo/src'), true);
  assert.equal(disk.isInside('/repo', '/repo-other/file'), false);
  assert.equal(disk.isInside('/repo', '/repo/../etc/passwd'), false);
  assert.equal(disk.join('/repo', 'src', '..', 'README.md'), '/repo/README.md');
  assert.equal(disk.basename('/repo/src/index.ts', '.ts'), 'index');
  assert.equal(disk.dirname('/repo/src/index.ts'), '/repo/src');
});

test('fakeFileSystem watch delivers emitChange with the relative path, and close unregisters', () => {
  const disk = fakeFileSystem({ files: { '/projects/-repo/a.jsonl': '' } });
  const seen: [string, string | null][] = [];
  const record = (event: string, rel: string | null): void => { seen.push([event, rel]); };

  const recursive = disk.watch('/projects', { recursive: true }, record);
  disk.emitChange('/projects/-repo/a.jsonl');
  disk.emitChange('/projects/-repo/b.jsonl', 'rename');
  assert.deepEqual(seen, [['change', '-repo/a.jsonl'], ['rename', '-repo/b.jsonl']]);
  recursive.close();

  seen.length = 0;
  const shallow = disk.watch('/projects', {}, record);
  disk.emitChange('/projects/-repo');
  disk.emitChange('/projects/-repo/a.jsonl');
  assert.deepEqual(seen, [['change', '-repo']], 'a plain directory watch sees children, not grandchildren');
  shallow.close();

  seen.length = 0;
  const single = disk.watch('/projects/-repo/a.jsonl', {}, record);
  disk.emitChange('/projects/-repo/a.jsonl');
  assert.deepEqual(seen, [['change', 'a.jsonl']], 'a watched file reports its own name');
  single.close();

  seen.length = 0;
  disk.emitChange('/projects/-repo/a.jsonl');
  assert.deepEqual(seen, [], 'closed watchers hear nothing');

  assert.throws(() => disk.watch('/projects/missing', {}, record), /ENOENT/);
});

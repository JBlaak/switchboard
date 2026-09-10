import { test } from 'node:test';
import assert from 'node:assert';
import { resolveRevealTarget } from '../src/main/ipc/host-handlers';
import { fakeFileSystem } from './support/fakes';

/**
 * The guard on `revealPath`, which is the only reason that channel is safe.
 *
 * `shell.showItemInFolder` cannot run anything, but it can open a window on any
 * directory on the machine — so a renderer that could name one could enumerate
 * the disk one refusal at a time. Everything below is about what the main
 * process refuses before the shell sees a path.
 */

const PROJECTS = ['/home/test/code/switchboard', '/home/test/code/other'];

const fsWith = (dirs: string[]) => fakeFileSystem({ dirs });

test('a directory inside a known project is resolved and allowed', () => {
  const fs = fsWith(['/home/test/code/switchboard/src']);
  assert.deepStrictEqual(
    resolveRevealTarget(fs, PROJECTS, '/home/test/code/switchboard/src'),
    { ok: true, path: '/home/test/code/switchboard/src' },
  );
});

test('a worktree under .claude/worktrees passes, because it is inside its parent', () => {
  const path = '/home/test/code/switchboard/.claude/worktrees/agent-a20a';
  const fs = fsWith([path]);
  assert.deepStrictEqual(resolveRevealTarget(fs, PROJECTS, path), { ok: true, path });
});

test('a path outside every known project is refused', () => {
  const fs = fsWith(['/etc']);
  const decision = resolveRevealTarget(fs, PROJECTS, '/etc');
  assert.strictEqual(decision.ok, false);
  assert.match(decision.ok ? '' : decision.error, /not inside a known project/);
});

test('a sibling checkout outside every project is refused even though it exists', () => {
  // `git worktree add ../feature-x` puts a real checkout somewhere the app was
  // never told about. Existing is not the same as being ours to open.
  const fs = fsWith(['/home/test/code/feature-x']);
  assert.strictEqual(resolveRevealTarget(fs, PROJECTS, '/home/test/code/feature-x').ok, false);
});

test('.. cannot walk out of a project and back in on paper', () => {
  // The string is inside a project by prefix and outside it once resolved,
  // which is the whole reason the guard resolves before it compares.
  const fs = fsWith(['/home/test/secrets']);
  const escape = '/home/test/code/switchboard/../../secrets';
  assert.strictEqual(resolveRevealTarget(fs, PROJECTS, escape).ok, false);
});

test('a path that is no longer on disk says so, rather than blaming the project list', () => {
  // A checkout deleted a moment ago is an ordinary event, and this is exactly
  // the state the rail's dashed sub-tile is in when its menu is opened.
  const fs = fsWith(['/home/test/code/switchboard']);
  const gone = '/home/test/code/switchboard/.claude/worktrees/agent-gone';
  const decision = resolveRevealTarget(fs, PROJECTS, gone);
  assert.strictEqual(decision.ok, false);
  assert.match(decision.ok ? '' : decision.error, /no longer on disk/);
});

test('a remote project has nothing on this machine to open', () => {
  const fs = fsWith(['/home/test/code/switchboard']);
  const decision = resolveRevealTarget(
    fs, ['ssh://user@host/srv/app', ...PROJECTS], 'ssh://user@host/srv/app');
  assert.strictEqual(decision.ok, false);
  assert.match(decision.ok ? '' : decision.error, /another machine/);
});

test('a remote project never lends its name to a local path', () => {
  // The remote entry must not be treated as a directory prefix that could
  // admit something: only local projects are asked.
  const fs = fsWith(['/srv/app']);
  assert.strictEqual(resolveRevealTarget(fs, ['ssh://user@host/srv/app'], '/srv/app').ok, false);
});

test('a non-string, an empty string and blank space are all refused before anything else', () => {
  const fs = fsWith(['/home/test/code/switchboard']);
  for (const bad of [undefined, null, 42, {}, '', '   ']) {
    assert.strictEqual(resolveRevealTarget(fs, PROJECTS, bad).ok, false, String(bad));
  }
});

test('an empty project list admits nothing', () => {
  const fs = fsWith(['/home/test/code/switchboard']);
  assert.strictEqual(resolveRevealTarget(fs, [], '/home/test/code/switchboard').ok, false);
});

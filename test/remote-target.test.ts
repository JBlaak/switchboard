import { test } from 'node:test';
import assert from 'node:assert';
import {
  isRemoteProjectPath, normalizeRemoteDir, parseRemoteProjectPath, remoteProjectPath,
  tmuxSessionName, validateRemoteInput,
} from '../src/domain/project/remote-target';

test('remoteProjectPath omits the default port', () => {
  /* When */
  const explicit = remoteProjectPath({ user: 'joris', host: '10.10.0.24', port: 22 });
  const implicit = remoteProjectPath({ user: 'joris', host: '10.10.0.24' });

  /* Then */
  assert.strictEqual(explicit, 'ssh://joris@10.10.0.24');
  assert.strictEqual(implicit, 'ssh://joris@10.10.0.24');
});

test('remoteProjectPath keeps a non-default port', () => {
  /* When */
  const path = remoteProjectPath({ user: 'joris', host: 'vm.local', port: 2222 });

  /* Then */
  assert.strictEqual(path, 'ssh://joris@vm.local:2222');
});

test('parseRemoteProjectPath reads back the target, defaulting the port', () => {
  /* When */
  const withPort = parseRemoteProjectPath('ssh://joris@vm.local:2222');
  const withoutPort = parseRemoteProjectPath('ssh://joris@10.10.0.24');

  /* Then */
  assert.deepStrictEqual(withPort, { user: 'joris', host: 'vm.local', port: 2222, dir: null });
  assert.deepStrictEqual(withoutPort, { user: 'joris', host: '10.10.0.24', port: 22, dir: null });
});

test('parseRemoteProjectPath rejects a filesystem path', () => {
  /* When */
  const parsed = parseRemoteProjectPath('/Users/joris/dev');

  /* Then */
  assert.strictEqual(parsed, null);
});

test('working directory is part of the project identity', () => {
  /* When */
  const home = remoteProjectPath({ user: 'u', host: 'h', dir: '~/apps/foo' });
  const absolute = remoteProjectPath({ user: 'u', host: 'h', port: 2222, dir: '/srv/app' });

  /* Then */
  assert.strictEqual(home, 'ssh://u@h/~/apps/foo');
  assert.strictEqual(absolute, 'ssh://u@h:2222//srv/app');
});

test('the home directory, blanks and trailing slashes normalize to the default', () => {
  // "~", "" and trailing slashes normalize to the default (home)
  /* When */
  const home = remoteProjectPath({ user: 'u', host: 'h', dir: '~' });
  const trailing = normalizeRemoteDir('~/apps/foo/');
  const blank = normalizeRemoteDir('  ');

  /* Then */
  assert.strictEqual(home, 'ssh://u@h');
  assert.strictEqual(trailing, '~/apps/foo');
  assert.strictEqual(blank, null);
});

test('a working directory round-trips through parse', () => {
  /* When */
  const absolute = parseRemoteProjectPath('ssh://u@h:2222//srv/app');
  const home = parseRemoteProjectPath('ssh://u@h/~/apps/foo');

  /* Then */
  assert.deepStrictEqual(absolute, { user: 'u', host: 'h', port: 2222, dir: '/srv/app' });
  assert.deepStrictEqual(home, { user: 'u', host: 'h', port: 22, dir: '~/apps/foo' });
});

test('isRemoteProjectPath distinguishes ssh pseudo-paths from filesystem paths', () => {
  /* When */
  const ssh = isRemoteProjectPath('ssh://a@b');
  const local = isRemoteProjectPath('/tmp/project');
  const none = isRemoteProjectPath(null);

  /* Then */
  assert.ok(ssh);
  assert.ok(!local);
  assert.ok(!none);
});

test('validateRemoteInput accepts a plain target', () => {
  /* Given */
  const valid = [
    { user: 'joris', host: '10.10.0.24' },
    { user: 'joris', host: '10.10.0.24', port: '2222' },
    { user: 'u', host: 'h', dir: '~/apps/my project' },
  ];

  for (const input of valid) {
    /* When */
    const error = validateRemoteInput(input);

    /* Then */
    assert.strictEqual(error, null);
  }
});

test('validateRemoteInput rejects characters that could escape the ssh argv', () => {
  /* Given */
  const invalid = [
    { user: 'joris; rm -rf /', host: 'h' },
    { user: 'joris', host: 'host$(x)' },
    { user: 'joris', host: 'h', port: 'abc' },
    { user: 'joris', host: 'h', port: 0 },
    {},
    { user: 'u', host: 'h', dir: '$(reboot)' },
    { user: 'u', host: 'h', dir: 'a"b' },
  ];

  for (const input of invalid) {
    /* When */
    const error = validateRemoteInput(input);

    /* Then */
    assert.ok(error);
  }
});

test('tmuxSessionName is short and safe for unquoted shell use', () => {
  /* When */
  const uuid = tmuxSessionName('8f14e45f-ceea-4672-9b3a-1c2d3e4f5a6b');
  const weird = tmuxSessionName('weird id!*');

  /* Then */
  assert.strictEqual(uuid, 'sb-8f14e45f');
  assert.match(weird, /^sb-[a-zA-Z0-9]*$/);
});

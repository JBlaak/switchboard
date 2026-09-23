import { test } from 'node:test';
import assert from 'node:assert';
import {
  isRemoteProjectPath, normalizeRemoteDir, parseRemoteProjectPath, remoteProjectPath,
  tmuxSessionName, validateRemoteInput,
} from '../src/domain/project/remote-target';

test('remoteProjectPath omits the default port and round-trips through parse', () => {
  assert.strictEqual(remoteProjectPath({ user: 'joris', host: '10.10.0.24', port: 22 }), 'ssh://joris@10.10.0.24');
  assert.strictEqual(remoteProjectPath({ user: 'joris', host: '10.10.0.24' }), 'ssh://joris@10.10.0.24');
  assert.strictEqual(remoteProjectPath({ user: 'joris', host: 'vm.local', port: 2222 }), 'ssh://joris@vm.local:2222');
  assert.deepStrictEqual(parseRemoteProjectPath('ssh://joris@vm.local:2222'), { user: 'joris', host: 'vm.local', port: 2222, dir: null });
  assert.deepStrictEqual(parseRemoteProjectPath('ssh://joris@10.10.0.24'), { user: 'joris', host: '10.10.0.24', port: 22, dir: null });
  assert.strictEqual(parseRemoteProjectPath('/Users/joris/dev'), null);
});

test('working directory is part of the project identity and round-trips', () => {
  assert.strictEqual(
    remoteProjectPath({ user: 'u', host: 'h', dir: '~/apps/foo' }),
    'ssh://u@h/~/apps/foo');
  assert.strictEqual(
    remoteProjectPath({ user: 'u', host: 'h', port: 2222, dir: '/srv/app' }),
    'ssh://u@h:2222//srv/app');
  // "~", "" and trailing slashes normalize to the default (home)
  assert.strictEqual(remoteProjectPath({ user: 'u', host: 'h', dir: '~' }), 'ssh://u@h');
  assert.strictEqual(normalizeRemoteDir('~/apps/foo/'), '~/apps/foo');
  assert.strictEqual(normalizeRemoteDir('  '), null);
  assert.deepStrictEqual(
    parseRemoteProjectPath('ssh://u@h:2222//srv/app'),
    { user: 'u', host: 'h', port: 2222, dir: '/srv/app' });
  assert.deepStrictEqual(
    parseRemoteProjectPath('ssh://u@h/~/apps/foo'),
    { user: 'u', host: 'h', port: 22, dir: '~/apps/foo' });
});

test('isRemoteProjectPath distinguishes ssh pseudo-paths from filesystem paths', () => {
  assert.ok(isRemoteProjectPath('ssh://a@b'));
  assert.ok(!isRemoteProjectPath('/tmp/project'));
  assert.ok(!isRemoteProjectPath(null));
});

test('validateRemoteInput rejects characters that could escape the ssh argv', () => {
  assert.strictEqual(validateRemoteInput({ user: 'joris', host: '10.10.0.24' }), null);
  assert.strictEqual(validateRemoteInput({ user: 'joris', host: '10.10.0.24', port: '2222' }), null);
  assert.ok(validateRemoteInput({ user: 'joris; rm -rf /', host: 'h' }));
  assert.ok(validateRemoteInput({ user: 'joris', host: 'host$(x)' }));
  assert.ok(validateRemoteInput({ user: 'joris', host: 'h', port: 'abc' }));
  assert.ok(validateRemoteInput({ user: 'joris', host: 'h', port: 0 }));
  assert.ok(validateRemoteInput({}));
  assert.strictEqual(validateRemoteInput({ user: 'u', host: 'h', dir: '~/apps/my project' }), null);
  assert.ok(validateRemoteInput({ user: 'u', host: 'h', dir: '$(reboot)' }));
  assert.ok(validateRemoteInput({ user: 'u', host: 'h', dir: 'a"b' }));
});

test('tmuxSessionName is short and safe for unquoted shell use', () => {
  assert.strictEqual(tmuxSessionName('8f14e45f-ceea-4672-9b3a-1c2d3e4f5a6b'), 'sb-8f14e45f');
  assert.match(tmuxSessionName('weird id!*'), /^sb-[a-zA-Z0-9]*$/);
});

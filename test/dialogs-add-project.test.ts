/**
 * What the Add Project dialog's fields ask main for, and the blank fields it
 * catches before asking.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localProjectRequest, remoteProjectRequest } from '../src/renderer/ui/dialogs/add-project-request';
import type { RemoteFields } from '../src/renderer/ui/dialogs/add-project-request';

function remote(over: Partial<RemoteFields> = {}): RemoteFields {
  return { user: 'deploy', host: 'staging.example.com', port: '', dir: '', ...over };
}

// ── Local ──

test('a local folder is asked for trimmed', () => {
  /* When */
  const request = localProjectRequest('  /Users/someone/project  ');

  /* Then */
  assert.deepEqual(request, { path: '/Users/someone/project' });
});

test('a blank folder path is an error, not a request', () => {
  /* When */
  const request = localProjectRequest('   ');

  /* Then */
  assert.deepEqual(request, { error: 'Please enter a folder path.' });
});

// ── Remote ──

test('a remote needs a user', () => {
  /* When */
  const request = remoteProjectRequest(remote({ user: ' ' }));

  /* Then */
  assert.deepEqual(request, { error: 'Please enter a username and host.' });
});

test('a remote needs a host', () => {
  /* When */
  const request = remoteProjectRequest(remote({ host: '' }));

  /* Then */
  assert.deepEqual(request, { error: 'Please enter a username and host.' });
});

test('the remote port defaults to 22', () => {
  /* When */
  const request = remoteProjectRequest(remote({ port: '  ' }));

  /* Then */
  assert.deepEqual(request, { config: { user: 'deploy', host: 'staging.example.com', port: 22, dir: '' } });
});

test('a port that is not a number is 22 too', () => {
  /* When */
  const request = remoteProjectRequest(remote({ port: 'ssh' }));

  /* Then */
  assert.ok('config' in request);
  assert.equal(request.config.port, 22);
});

test('a given port is kept, and every field is trimmed', () => {
  /* When */
  const request = remoteProjectRequest({ user: ' deploy ', host: ' two.example.com ', port: ' 2222 ', dir: ' ~/apps/api ' });

  /* Then */
  assert.deepEqual(request, { config: { user: 'deploy', host: 'two.example.com', port: 2222, dir: '~/apps/api' } });
});

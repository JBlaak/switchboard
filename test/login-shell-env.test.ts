import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pathFromShellOutput, withFallbackPath } from '../src/infrastructure/shell/login-shell-env';

test('the login PATH is read from between the markers, whatever the shell printed around it', () => {
  /* Given */
  const output = 'Welcome back!\n__SWITCHBOARD_PATH__/opt/homebrew/bin:/usr/bin\n__SWITCHBOARD_PATH__bye\n';

  /* When */
  const loginPath = pathFromShellOutput(output);

  /* Then */
  assert.equal(loginPath, '/opt/homebrew/bin:/usr/bin');
});

test('output without markers yields no login PATH', () => {
  /* When */
  const loginPath = pathFromShellOutput('no markers here');

  /* Then */
  assert.equal(loginPath, null);
});

test('an empty PATH between the markers yields no login PATH', () => {
  /* When */
  const loginPath = pathFromShellOutput('__SWITCHBOARD_PATH____SWITCHBOARD_PATH__');

  /* Then */
  assert.equal(loginPath, null);
});

test('without a login PATH, Homebrew\'s directories are added to the one the app has', () => {
  /* When */
  const neither = withFallbackPath('/usr/bin:/bin');
  const oneAlready = withFallbackPath('/usr/local/bin:/usr/bin');
  const none = withFallbackPath(undefined);

  /* Then */
  assert.equal(neither, '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.equal(oneAlready, '/usr/local/bin:/usr/bin:/opt/homebrew/bin');
  assert.equal(none, '/opt/homebrew/bin:/usr/local/bin');
});

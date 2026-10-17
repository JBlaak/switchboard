import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pathFromShellOutput, withFallbackPath } from '../src/infrastructure/shell/login-shell-env';

test('the login PATH is read from between the markers, whatever the shell printed around it', () => {
  const output = 'Welcome back!\n__SWITCHBOARD_PATH__/opt/homebrew/bin:/usr/bin\n__SWITCHBOARD_PATH__bye\n';
  assert.equal(pathFromShellOutput(output), '/opt/homebrew/bin:/usr/bin');
  assert.equal(pathFromShellOutput('no markers here'), null);
  assert.equal(pathFromShellOutput('__SWITCHBOARD_PATH____SWITCHBOARD_PATH__'), null);
});

test('without a login PATH, Homebrew\'s directories are added to the one the app has', () => {
  assert.equal(withFallbackPath('/usr/bin:/bin'), '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.equal(withFallbackPath('/usr/local/bin:/usr/bin'), '/usr/local/bin:/usr/bin:/opt/homebrew/bin');
  assert.equal(withFallbackPath(undefined), '/opt/homebrew/bin:/usr/local/bin');
});

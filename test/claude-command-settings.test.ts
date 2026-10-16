import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, buildClaudeCommand } from '../src/domain/launch/claude-command';
import { questionHookSettings } from '../src/domain/questions/question';

const settings = questionHookSettings('http://127.0.0.1:4321/questions', "tok'en");
const fresh = { sessionId: 'abc', isNew: true };
const resumed = { sessionId: 'abc', isNew: false };

test('settings are passed for a new session with no options', () => {
  assert.deepEqual(buildClaudeArgs(fresh, undefined, settings), ['--settings', settings, '--session-id', 'abc']);
});

test('settings are passed for a resumed session with no options', () => {
  assert.deepEqual(buildClaudeArgs(resumed, undefined, settings), ['--settings', settings, '--resume', 'abc']);
});

test('settings sit alongside the session options', () => {
  const args = buildClaudeArgs(fresh, { permissionMode: 'plan', chrome: true }, settings);
  assert.deepEqual(args, ['--settings', settings, '--session-id', 'abc', '--permission-mode', 'plan', '--chrome']);
  const resumedArgs = buildClaudeArgs(resumed, { dangerouslySkipPermissions: true }, settings);
  assert.deepEqual(resumedArgs, ['--settings', settings, '--resume', 'abc', '--dangerously-skip-permissions']);
});

test('without settings there is no --settings flag', () => {
  assert.equal(buildClaudeArgs(fresh).includes('--settings'), false);
  assert.equal(buildClaudeArgs(resumed, { chrome: true }, '').includes('--settings'), false);
  assert.equal(buildClaudeCommand({ target: fresh }).includes('--settings'), false);
});

test('the command quotes the settings JSON as one shell word', () => {
  const command = buildClaudeCommand({ target: resumed, settings });
  const quoted = "'" + settings.replace(/'/g, "'\\''") + "'";
  assert.equal(command, `claude '--settings' ${quoted} '--resume' 'abc'`);
});

test('the settings survive a pre-launch command', () => {
  const command = buildClaudeCommand({ target: fresh, options: { preLaunchCmd: 'aws-vault exec dev --' }, settings });
  assert.ok(command.startsWith("aws-vault exec dev -- claude '--settings' '{"));
  assert.ok(command.endsWith("'--session-id' 'abc'"));
});

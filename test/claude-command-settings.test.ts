import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, buildClaudeCommand } from '../src/domain/launch/claude-command';
import { questionHookSettings } from '../src/domain/questions/question';

const settings = questionHookSettings({ ask: 'http://127.0.0.1:4321/ask/abc', stop: 'http://127.0.0.1:4321/stop/abc', prompt: 'http://127.0.0.1:4321/prompt/abc' }, "tok'en");
const fresh = { sessionId: 'abc', isNew: true };
const resumed = { sessionId: 'abc', isNew: false };

test('settings are passed for a new session with no options', () => {
  /* When */
  const args = buildClaudeArgs(fresh, undefined, settings);

  /* Then */
  assert.deepEqual(args, ['--settings', settings, '--session-id', 'abc']);
});

test('settings are passed for a resumed session with no options', () => {
  /* When */
  const args = buildClaudeArgs(resumed, undefined, settings);

  /* Then */
  assert.deepEqual(args, ['--settings', settings, '--resume', 'abc']);
});

test('settings sit alongside a new session\'s options', () => {
  /* When */
  const args = buildClaudeArgs(fresh, { permissionMode: 'plan', chrome: true }, settings);

  /* Then */
  assert.deepEqual(args, ['--settings', settings, '--session-id', 'abc', '--permission-mode', 'plan', '--chrome']);
});

test('settings sit alongside a resumed session\'s options', () => {
  /* When */
  const args = buildClaudeArgs(resumed, { dangerouslySkipPermissions: true }, settings);

  /* Then */
  assert.deepEqual(args, ['--settings', settings, '--resume', 'abc', '--dangerously-skip-permissions']);
});

test('without settings there is no --settings flag in the args', () => {
  /* When */
  const omitted = buildClaudeArgs(fresh);
  const empty = buildClaudeArgs(resumed, { chrome: true }, '');

  /* Then */
  assert.equal(omitted.includes('--settings'), false);
  assert.equal(empty.includes('--settings'), false);
});

test('without settings there is no --settings flag in the command', () => {
  /* When */
  const command = buildClaudeCommand({ target: fresh });

  /* Then */
  assert.equal(command.includes('--settings'), false);
});

test('the command quotes the settings JSON as one shell word', () => {
  /* Given */
  const quoted = "'" + settings.replace(/'/g, "'\\''") + "'";

  /* When */
  const command = buildClaudeCommand({ target: resumed, settings });

  /* Then */
  assert.equal(command, `claude '--settings' ${quoted} '--resume' 'abc'`);
});

test('the settings survive a pre-launch command', () => {
  /* When */
  const command = buildClaudeCommand({ target: fresh, options: { preLaunchCmd: 'aws-vault exec dev --' }, settings });

  /* Then */
  assert.ok(command.startsWith("aws-vault exec dev -- claude '--settings' '{"));
  assert.ok(command.endsWith("'--session-id' 'abc'"));
});

test('a new session\'s first prompt goes last, behind --, after a variadic --add-dir', () => {
  /* When */
  const args = buildClaudeArgs(fresh, { addDirs: '/a,/b', initialPrompt: 'Work on #114' });

  /* Then */
  assert.deepEqual(args, ['--session-id', 'abc', '--add-dir', '/a', '--add-dir', '/b', '--', 'Work on #114']);
});

test('a resumed session is never handed a first prompt', () => {
  /* When */
  const args = buildClaudeArgs(resumed, { initialPrompt: 'Work on #114' });

  /* Then */
  assert.deepEqual(args, ['--resume', 'abc']);
});

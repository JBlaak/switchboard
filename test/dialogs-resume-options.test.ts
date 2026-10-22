/**
 * Resume with config, from the dialog's fields to the argv claude is resumed
 * with: the dialog opens on the project's effective settings, each click goes
 * through `pickPermission`, and Resume folds the selection and the fields into
 * the launch options the way `ResumeSessionDialog` does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs } from '../src/domain/launch/claude-command';
import {
  DANGEROUS_SKIP, applyPermissionSelection, initialPermissionSelection, pickPermission,
} from '../src/renderer/ui/dialogs/permission-selection';
import { applySessionFields, initialSessionFields } from '../src/renderer/ui/dialogs/SessionFields';
import type { EffectiveSettings } from '../src/domain/settings/settings';
import type { SessionFieldValues } from '../src/renderer/ui/dialogs/SessionFields';
import type { SessionOptions } from '../src/domain/launch/session-options';

const PROJECT: EffectiveSettings = {
  permissionMode: 'plan', chrome: true, preLaunchCmd: 'env SB_E2E=1', addDirs: '/opt/a, /opt/b',
};

/** Open the dialog on `settings`, click `clicks` in the grid, edit the fields, and resume. */
function resume(
  settings: EffectiveSettings,
  clicks: (string | null)[] = [],
  edit: (fields: SessionFieldValues) => SessionFieldValues = fields => fields,
): string[] {
  const selection = clicks.reduce(pickPermission, initialPermissionSelection(settings));
  const options: SessionOptions = {};
  applyPermissionSelection(options, selection);
  applySessionFields(options, edit(initialSessionFields(settings)));
  return buildClaudeArgs({ sessionId: 'abc', isNew: false }, options);
}

test('the fields start from the effective settings', () => {
  /* When */
  const fields = initialSessionFields(PROJECT);
  const selection = initialPermissionSelection(PROJECT);

  /* Then */
  assert.deepEqual(fields, { chrome: true, preLaunchCmd: 'env SB_E2E=1', addDirs: '/opt/a, /opt/b' });
  assert.deepEqual(selection, { mode: 'plan', dangerousSkip: false });
});

test('a project that stores Default as an empty mode opens on Default', () => {
  /* When */
  const selection = initialPermissionSelection({ ...PROJECT, permissionMode: '' });

  /* Then */
  assert.deepEqual(selection, { mode: null, dangerousSkip: false });
});

test('a project that skips permissions opens with Dangerous Skip on', () => {
  /* When */
  const selection = initialPermissionSelection({ permissionMode: 'plan', dangerouslySkipPermissions: true });

  /* Then */
  assert.deepEqual(selection, { mode: 'plan', dangerousSkip: true });
});

test('resuming as opened passes the settings on', () => {
  /* When */
  const argv = resume(PROJECT);

  /* Then */
  assert.deepEqual(argv, ['--resume', 'abc', '--permission-mode', 'plan',
    '--chrome', '--add-dir', '/opt/a', '--add-dir', '/opt/b']);
});

test('what the fields are changed to is what it resumes with', () => {
  /* When */
  const argv = resume(PROJECT, [], fields => ({ ...fields, chrome: false, addDirs: '' }));

  /* Then */
  assert.deepEqual(argv, ['--resume', 'abc', '--permission-mode', 'plan']);
});

test('picking a mode replaces the one before it', () => {
  /* When */
  const argv = resume(PROJECT, ['auto', 'acceptEdits']);

  /* Then */
  assert.deepEqual(argv.filter(arg => arg === '--permission-mode'), ['--permission-mode']);
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
});

test('Default omits the flag', () => {
  /* When */
  const argv = resume(PROJECT, [null]);

  /* Then */
  assert.ok(!argv.includes('--permission-mode'));
});

test('Dangerous Skip replaces the mode', () => {
  /* When */
  const argv = resume(PROJECT, [DANGEROUS_SKIP]);

  /* Then */
  assert.ok(argv.includes('--dangerously-skip-permissions'));
  assert.ok(!argv.includes('--permission-mode'));
});

test('Dangerous Skip toggles off again, and the mode it cleared stays cleared', () => {
  /* When */
  const argv = resume(PROJECT, [DANGEROUS_SKIP, DANGEROUS_SKIP]);

  /* Then */
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
  assert.ok(!argv.includes('--permission-mode'));
});

test('picking a mode clears Dangerous Skip', () => {
  /* When */
  const argv = resume(PROJECT, [DANGEROUS_SKIP, 'plan']);

  /* Then */
  assert.ok(!argv.includes('--dangerously-skip-permissions'));
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'plan');
});

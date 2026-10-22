/**
 * A project's overrides of the global launch settings (#176): what each field
 * shows, when it overrides the global default, what a change stores and what
 * "Reset to global settings" leaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_SETTING_FIELDS, describeSettingValue, hasOverrides, permissionModeChoices, projectFieldStates,
  withProjectValue, withoutOverrides,
} from '../src/domain/settings/project-overrides';
import { mergeEffectiveSettings } from '../src/domain/settings/settings';

const GLOBAL = { permissionMode: 'plan', worktree: true, preLaunchCmd: 'aws-vault exec dev --', terminalTheme: 'nord' };

test('a field the project does not set shows the global value and does not override it', () => {
  /* When */
  const fields = projectFieldStates(GLOBAL, {});

  /* Then */
  assert.deepEqual(fields.worktree, { value: true, globalValue: true, overrides: false });
  assert.deepEqual(fields.permissionMode, { value: 'plan', globalValue: 'plan', overrides: false });
  assert.deepEqual(fields.chrome, { value: false, globalValue: false, overrides: false });
});

test('a field the project sets to another value overrides the global one', () => {
  /* When */
  const fields = projectFieldStates(GLOBAL, { worktree: false, addDirs: '/opt/shared' });

  /* Then */
  assert.deepEqual(fields.worktree, { value: false, globalValue: true, overrides: true });
  assert.deepEqual(fields.addDirs, { value: '/opt/shared', globalValue: '', overrides: true });
});

test('a field the project stores at the global value says it is the same as global', () => {
  /* When */
  const fields = projectFieldStates(GLOBAL, { worktree: true, preLaunchCmd: ' aws-vault exec dev -- ' });

  /* Then */
  assert.equal(fields.worktree.overrides, false);
  assert.equal(fields.preLaunchCmd.overrides, false);
});

test('a change to another value than the global one is stored as an override, keeping other keys', () => {
  /* Given */
  const project = { chrome: true, shellProfile: 'zsh' };

  /* When */
  const next = withProjectValue(GLOBAL, project, 'worktree', false);

  /* Then */
  assert.deepEqual(next, { chrome: true, shellProfile: 'zsh', worktree: false });
});

test('a change back to the global value drops the override', () => {
  /* Given */
  const project = { worktree: false, chrome: true };

  /* When */
  const next = withProjectValue(GLOBAL, project, 'worktree', true);

  /* Then */
  assert.deepEqual(next, { chrome: true });
});

test('text is stored trimmed, and an empty text over a global one is an override', () => {
  /* When */
  const padded = withProjectValue(GLOBAL, {}, 'addDirs', '  /a, /b ');
  const cleared = withProjectValue(GLOBAL, {}, 'preLaunchCmd', '   ');

  /* Then */
  assert.deepEqual(padded, { addDirs: '/a, /b' });
  assert.deepEqual(cleared, { preLaunchCmd: '' });
  assert.equal(mergeEffectiveSettings(GLOBAL, cleared).preLaunchCmd, '');
});

test('Default over a global mode is stored as an empty mode, which launches with no mode', () => {
  /* When */
  const next = withProjectValue(GLOBAL, {}, 'permissionMode', null);

  /* Then */
  assert.deepEqual(next, { permissionMode: '' });
  assert.equal(mergeEffectiveSettings(GLOBAL, next).permissionMode, '');
  assert.deepEqual(projectFieldStates(GLOBAL, next).permissionMode, { value: null, globalValue: 'plan', overrides: true });
});

test('Default with no global mode is no override', () => {
  /* When */
  const next = withProjectValue({}, { permissionMode: 'acceptEdits' }, 'permissionMode', null);

  /* Then */
  assert.deepEqual(next, {});
});

test('Reset drops every field the project can override and keeps the rest', () => {
  /* Given */
  const project = {
    permissionMode: 'acceptEdits', dangerouslySkipPermissions: true, worktree: false, chrome: true,
    preLaunchCmd: 'direnv exec .', addDirs: '/x', shellProfile: 'zsh',
  };

  /* When */
  const next = withoutOverrides(project);

  /* Then */
  assert.deepEqual(next, { shellProfile: 'zsh' });
  assert.equal(hasOverrides(GLOBAL, next), false);
  for (const field of PROJECT_SETTING_FIELDS) {
    assert.equal(projectFieldStates(GLOBAL, next)[field].overrides, false, field);
  }
});

test('the project has overrides only while a field differs from the global value', () => {
  /* When */
  const none = hasOverrides(GLOBAL, { worktree: true });
  const some = hasOverrides(GLOBAL, { chrome: true });

  /* Then */
  assert.equal(none, false);
  assert.equal(some, true);
});

test('the mode control offers Default, Accept edits, Plan and Bypass, and a mode set elsewhere besides', () => {
  /* When */
  const usual = permissionModeChoices('plan').map(choice => choice.label);
  const other = permissionModeChoices('auto').map(choice => choice.value);

  /* Then */
  assert.deepEqual(usual, ['Default', 'Accept edits', 'Plan', 'Bypass']);
  assert.deepEqual(other, [null, 'acceptEdits', 'plan', 'bypassPermissions', 'auto']);
});

test('a global value reads as the mode’s label, on or off, or the text', () => {
  /* When */
  const described = [
    describeSettingValue('permissionMode', null),
    describeSettingValue('permissionMode', 'dontAsk'),
    describeSettingValue('worktree', true),
    describeSettingValue('chrome', false),
    describeSettingValue('addDirs', ''),
    describeSettingValue('preLaunchCmd', 'direnv exec .'),
  ];

  /* Then */
  assert.deepEqual(described, ['Default', "Don't Ask", 'on', 'off', 'none', 'direnv exec .']);
});

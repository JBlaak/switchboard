import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_APPEARANCE, isAppearance, nextAppearance, normaliseAppearance,
} from '../src/domain/settings/appearance';

test('cycles system → light → dark → system', () => {
  assert.equal(nextAppearance('system'), 'light');
  assert.equal(nextAppearance('light'), 'dark');
  assert.equal(nextAppearance('dark'), 'system');
});

test('three clicks come back to where they started', () => {
  for (const mode of ['system', 'light', 'dark'] as const) {
    assert.equal(nextAppearance(nextAppearance(nextAppearance(mode))), mode);
  }
});

test('recognises exactly the three modes', () => {
  assert.ok(isAppearance('system'));
  assert.ok(isAppearance('light'));
  assert.ok(isAppearance('dark'));
  assert.equal(isAppearance('Dark'), false);
  assert.equal(isAppearance(''), false);
  assert.equal(isAppearance(null), false);
  assert.equal(isAppearance(undefined), false);
  assert.equal(isAppearance(1), false);
});

test('the default is to follow the system', () => {
  assert.equal(DEFAULT_APPEARANCE, 'system');
});

test('a stored mode survives normalising', () => {
  assert.equal(normaliseAppearance('light'), 'light');
  assert.equal(normaliseAppearance('dark'), 'dark');
  assert.equal(normaliseAppearance('system'), 'system');
});

test('anything else falls back to system rather than reaching themeSource', () => {
  // Never written: a fresh install, or a blob from before the toggle existed.
  assert.equal(normaliseAppearance(undefined), 'system');
  // Cleared by the settings panel.
  assert.equal(normaliseAppearance(null), 'system');
  // Hand-edited or written by a newer build.
  assert.equal(normaliseAppearance('sepia'), 'system');
  assert.equal(normaliseAppearance({ mode: 'dark' }), 'system');
});

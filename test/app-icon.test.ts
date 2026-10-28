import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_APP_ICON, isAppIcon, normaliseAppIcon } from '../src/domain/settings/app-icon';

test('the original Switchboard icon is the default', () => {
  /* Then */
  assert.equal(DEFAULT_APP_ICON, 'switchboard');
});

test('recognises both icons', () => {
  /* Given */
  const icons = ['switchboard', 'patch'];

  /* When */
  const recognised = icons.map(isAppIcon);

  /* Then */
  assert.deepEqual(recognised, [true, true]);
});

test('keeps a known icon as it is', () => {
  /* When */
  const icon = normaliseAppIcon('patch');

  /* Then */
  assert.equal(icon, 'patch');
});

test('falls back to the Switchboard icon for anything unknown', () => {
  /* Given */
  const values = [undefined, null, '', 'Patch', 'dark', 42, {}];

  for (const value of values) {
    /* When */
    const icon = normaliseAppIcon(value);

    /* Then */
    assert.equal(icon, 'switchboard');
  }
});

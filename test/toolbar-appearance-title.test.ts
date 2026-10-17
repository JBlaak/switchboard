import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceTitle } from '../src/domain/settings/appearance';

test('the appearance toggle names its mode and the one a click moves to', () => {
  /* When */
  const titles = (['system', 'light', 'dark'] as const).map(appearanceTitle);

  /* Then */
  assert.deepEqual(titles, [
    'Appearance: System (click for Light)',
    'Appearance: Light (click for Dark)',
    'Appearance: Dark (click for System)',
  ]);
});

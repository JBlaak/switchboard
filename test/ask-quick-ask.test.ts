import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quickAskOutcome } from '../src/domain/ask/quick-ask';
import type { QuickRouteResult } from '../src/domain/ask/model';

/**
 * Quick Ask's outcome rule (#142, R2): what the pop-up does with a routing
 * result, with and without a Quick Session Folder.
 */

const TYPED = 'lets fix the login bug in app';
const QUICK = '/code/scratch';

const rows: { name: string; result: QuickRouteResult; withFolder: unknown; withoutFolder: unknown }[] = [
  {
    name: 'confident starts the session on the rewritten prompt',
    result: { kind: 'confident', projectPath: '/code/app', prompt: 'Fix the login bug.' },
    withFolder: { kind: 'start', projectPath: '/code/app', prompt: 'Fix the login bug.' },
    withoutFolder: { kind: 'start', projectPath: '/code/app', prompt: 'Fix the login bug.' },
  },
  {
    name: 'unsure shows the choices in the pop-up',
    result: { kind: 'unsure', candidates: ['/code/app', '/code/site'], prompt: 'Fix the login bug.' },
    withFolder: { kind: 'choose', candidates: ['/code/app', '/code/site'], prompt: 'Fix the login bug.' },
    withoutFolder: { kind: 'choose', candidates: ['/code/app', '/code/site'], prompt: 'Fix the login bug.' },
  },
  {
    name: 'noMatch starts a quick session on the text as typed, or opens the picker',
    result: { kind: 'noMatch', reason: 'No idea.' },
    withFolder: { kind: 'start', projectPath: QUICK, prompt: TYPED },
    withoutFolder: { kind: 'picker', prompt: TYPED, reason: 'No idea.' },
  },
  {
    name: 'failed starts a quick session on the text as typed, or opens the picker',
    result: { kind: 'failed', reason: 'Usage limit.' },
    withFolder: { kind: 'start', projectPath: QUICK, prompt: TYPED },
    withoutFolder: { kind: 'picker', prompt: TYPED, reason: 'Usage limit.' },
  },
  {
    name: 'cancelled goes back to editing',
    result: { kind: 'cancelled' },
    withFolder: { kind: 'unlock' },
    withoutFolder: { kind: 'unlock' },
  },
  {
    name: 'capture captures',
    result: { kind: 'capture', target: 'tasks', text: 'call Peter' },
    withFolder: { kind: 'capture', target: 'tasks', text: 'call Peter' },
    withoutFolder: { kind: 'capture', target: 'tasks', text: 'call Peter' },
  },
];

for (const row of rows) {
  test(`${row.name}, with a quick folder`, () => {
    /* Given */
    const result = row.result;

    /* When */
    const outcome = quickAskOutcome(result, TYPED, QUICK);

    /* Then */
    assert.deepEqual(outcome, row.withFolder);
  });

  test(`${row.name}, without a quick folder`, () => {
    /* Given */
    const result = row.result;

    /* When */
    const outcome = quickAskOutcome(result, TYPED, '');

    /* Then */
    assert.deepEqual(outcome, row.withoutFolder);
  });
}

test('noMatch with a skill command starts a quick session on it, not the text as typed', () => {
  /* Given */
  const result: QuickRouteResult = { kind: 'noMatch', reason: 'No idea.', prompt: '/grill-me' };

  /* When */
  const outcome = quickAskOutcome(result, 'Grill me', QUICK);

  /* Then */
  assert.deepEqual(outcome, { kind: 'start', projectPath: QUICK, prompt: '/grill-me' });
});

test('noMatch with a skill command and no quick folder opens the picker on it', () => {
  /* Given */
  const result: QuickRouteResult = { kind: 'noMatch', reason: 'No idea.', prompt: '/grill-me' };

  /* When */
  const outcome = quickAskOutcome(result, 'Grill me', '');

  /* Then */
  assert.deepEqual(outcome, { kind: 'picker', prompt: '/grill-me', reason: 'No idea.' });
});

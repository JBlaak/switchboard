import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isRemoteRow, NO_REPO_REASON, REMOTE_REASON, workTrigger } from '../src/renderer/ui/session-list/work-trigger';

test('a row main says can open is the Session work button', () => {
  /* When */
  const trigger = workTrigger(false, true);

  /* Then */
  assert.deepEqual(trigger, { button: true });
});

test('a remote row is text that says Session work is not there for remote sessions yet', () => {
  /* When */
  const trigger = workTrigger(true, false);

  /* Then */
  assert.deepEqual(trigger, { button: false, reason: REMOTE_REASON });
});

test('a row outside a repository is text that says so', () => {
  /* When */
  const trigger = workTrigger(false, false);

  /* Then */
  assert.deepEqual(trigger, { button: false, reason: NO_REPO_REASON });
});

test('while main is asked the line is text without a reason', () => {
  /* When */
  const trigger = workTrigger(false, undefined);

  /* Then */
  assert.deepEqual(trigger, { button: false, reason: undefined });
});

test('a row is remote by its type or by an ssh:// project path', () => {
  /* When */
  const verdicts = [
    isRemoteRow({ type: 'remote' }, '/Users/joris/api'),
    isRemoteRow({}, 'ssh://joris@buildbox/~/api'),
    isRemoteRow({ type: 'claude' }, '/Users/joris/api'),
    isRemoteRow({}, null),
  ];

  /* Then */
  assert.deepEqual(verdicts, [true, true, false, false]);
});

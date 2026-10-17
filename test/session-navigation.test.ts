import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepOpenSession } from '../src/renderer/state/list-cursor';

/** The sidebar's row order; every one of them open unless `ended` says otherwise. */
const ORDER = ['a', 'b', 'c', 'd'];
const openExcept = (...ended: string[]) => (id: string) => !ended.includes(id);
const allOpen = openExcept();

test('the next session is the next open one in sidebar order', () => {
  /* When */
  const next = stepOpenSession(ORDER, allOpen, 'b', 1);

  /* Then */
  assert.equal(next, 'c');
});

test('stepping wraps round at both ends', () => {
  /* When */
  const pastTheEnd = stepOpenSession(ORDER, allOpen, 'd', 1);
  const beforeTheStart = stepOpenSession(ORDER, allOpen, 'a', -1);

  /* Then */
  assert.equal(pastTheEnd, 'a');
  assert.equal(beforeTheStart, 'd');
});

test('rows with no open session are not stepped onto', () => {
  /* Given */
  const isOpen = (id: string) => id === 'a' || id === 'c';

  /* When */
  const next = stepOpenSession(ORDER, isOpen, 'a', 1);

  /* Then */
  assert.equal(next, 'c');
});

test('a session whose process has ended is skipped', () => {
  /* When */
  const next = stepOpenSession(ORDER, openExcept('c'), 'b', 1);

  /* Then */
  assert.equal(next, 'd');
});

test('with no session on screen, it goes to the first open one, either way', () => {
  /* When */
  const forward = stepOpenSession(ORDER, openExcept('a'), null, 1);
  const back = stepOpenSession(ORDER, openExcept('a'), null, -1);

  /* Then */
  assert.equal(forward, 'b');
  assert.equal(back, 'b');
});

test('a session on screen that is not open counts as none', () => {
  /* When */
  const next = stepOpenSession(ORDER, openExcept('b'), 'b', 1);

  /* Then */
  assert.equal(next, 'a');
});

test('with nothing open there is nowhere to go', () => {
  /* When */
  const next = stepOpenSession(ORDER, () => false, 'a', 1);

  /* Then */
  assert.equal(next, null);
});

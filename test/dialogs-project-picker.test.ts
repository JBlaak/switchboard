/**
 * The project picker's highlight and row counts: which row Enter opens as the
 * keys, the query and the pointer move it, and what each row says it holds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampSelection, nextSelection, sessionCountLabel } from '../src/renderer/ui/dialogs/picker-selection';
import { tooltip } from '../src/renderer/ui/dialogs/DialogShell';

// ── The highlight ──

test('ArrowDown moves the highlight one row down', () => {
  /* When */
  const next = nextSelection(1, 5, { type: 'stepped', step: 1 });

  /* Then */
  assert.equal(next, 2);
});

test('ArrowUp from the top wraps to the bottom', () => {
  /* When */
  const next = nextSelection(0, 5, { type: 'stepped', step: -1 });

  /* Then */
  assert.equal(next, 4);
});

test('ArrowDown past the bottom wraps to the top', () => {
  /* When */
  const next = nextSelection(4, 5, { type: 'stepped', step: 1 });

  /* Then */
  assert.equal(next, 0);
});

test('a step starts from the last row when the list shrank under the highlight', () => {
  /* When */
  const next = nextSelection(4, 3, { type: 'stepped', step: -1 });

  /* Then */
  assert.equal(next, 1);
});

test('the arrows do nothing with no rows', () => {
  /* When */
  const next = nextSelection(0, 0, { type: 'stepped', step: 1 });

  /* Then */
  assert.equal(next, 0);
});

test('a new query starts the highlight from the top again', () => {
  /* When */
  const next = nextSelection(2, 3, { type: 'queried' });

  /* Then */
  assert.equal(next, 0);
});

test('hovering a row highlights it for Enter', () => {
  /* When */
  const next = nextSelection(0, 5, { type: 'hovered', index: 3 });

  /* Then */
  assert.equal(next, 3);
});

test('the highlight is kept within a list that shrank under it', () => {
  /* When */
  const clamped = [clampSelection(4, 3), clampSelection(1, 3), clampSelection(2, 0)];

  /* Then */
  assert.deepEqual(clamped, [2, 1, 0]);
});

// ── The row counts ──

test('a row counts its sessions, singular for one', () => {
  /* When */
  const labels = [sessionCountLabel(0, 0), sessionCountLabel(1, 0), sessionCountLabel(6, 0)];

  /* Then */
  assert.deepEqual(labels, ['0 sessions', '1 session', '6 sessions']);
});

test('a row with sessions running says how many run instead', () => {
  /* When */
  const label = sessionCountLabel(6, 2);

  /* Then */
  assert.equal(label, '2 running');
});

// ── The row's icon buttons ──

test('an icon button’s tooltip is also its accessible name', () => {
  /* When */
  const props = tooltip('Hide worktree');

  /* Then */
  assert.deepEqual(props, { 'data-tooltip': 'Hide worktree', 'aria-label': 'Hide worktree' });
});

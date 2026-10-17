import { test } from 'node:test';
import assert from 'node:assert';
import { rowSurvivesTruncation, TIER_RUNNING, TIER_REST } from '../src/domain/session/tiers';

const NOW = 1_700_000_000_000;
const DAY = 86400000;

// A row well past the age cutoff and well past the visible-count budget: it
// survives only if one of the exemptions applies.
function staleRow(extra = {}) {
  return { pinned: false, remote: false, sortTime: NOW - 30 * DAY, ...extra };
}
const caps = { count: 99, visibleSessionCount: 25, ageCutoff: NOW - 3 * DAY, isActive: false };

test('a stale local row is truncated', () => {
  /* Given */
  const row = staleRow();

  /* When */
  const survives = rowSurvivesTruncation(row, TIER_REST, caps);

  /* Then */
  assert.strictEqual(survives, false);
});

test('a remote row survives however old it looks', () => {
  // The regression this guards: a remote session whose tmux session is still
  // running on the host, but whose `modified` has not moved since the user last
  // opened it, was dropped from the list — indistinguishable from archiving.
  /* Given */
  const row = staleRow({ remote: true });

  /* When */
  const survives = rowSurvivesTruncation(row, TIER_REST, caps);

  /* Then */
  assert.strictEqual(survives, true);
});

test('a remote row is exempt from the count budget, not just the age cutoff', () => {
  /* Given */
  const row = staleRow({ remote: true, sortTime: NOW });

  /* When */
  const survives = rowSurvivesTruncation(row, TIER_REST, caps);

  /* Then */
  assert.strictEqual(survives, true);
});

test('a running row survives however stale', () => {
  /* Given */
  const row = staleRow();

  /* When */
  const survives = rowSurvivesTruncation(row, TIER_RUNNING, caps);

  /* Then */
  assert.strictEqual(survives, true);
});

test('a pinned row survives however stale', () => {
  /* Given */
  const row = staleRow({ pinned: true });

  /* When */
  const survives = rowSurvivesTruncation(row, TIER_REST, caps);

  /* Then */
  assert.strictEqual(survives, true);
});

test('the active row survives however stale', () => {
  /* Given */
  const row = staleRow();

  /* When */
  const survives = rowSurvivesTruncation(row, TIER_REST, { ...caps, isActive: true });

  /* Then */
  assert.strictEqual(survives, true);
});

test('a recent local row survives while there is budget', () => {
  /* Given */
  const recent = staleRow({ sortTime: NOW - DAY });

  /* When */
  const survives = rowSurvivesTruncation(recent, TIER_REST, { ...caps, count: 24 });

  /* Then */
  assert.strictEqual(survives, true);
});

test('a recent local row is truncated once the budget is spent', () => {
  // Budget spent: recency alone is not enough.
  /* Given */
  const recent = staleRow({ sortTime: NOW - DAY });

  /* When */
  const survives = rowSurvivesTruncation(recent, TIER_REST, { ...caps, count: 25 });

  /* Then */
  assert.strictEqual(survives, false);
});

test('an in-budget local row older than the cutoff is truncated', () => {
  // In budget but older than the cutoff: the age check is not enough either.
  /* Given */
  const row = staleRow();

  /* When */
  const survives = rowSurvivesTruncation(row, TIER_REST, { ...caps, count: 0 });

  /* Then */
  assert.strictEqual(survives, false);
});

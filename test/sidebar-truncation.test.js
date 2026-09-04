const { test } = require('node:test');
const assert = require('node:assert');
const { rowSurvivesTruncation, TIER_RUNNING, TIER_REST } = require('../public/sidebar');

const NOW = 1_700_000_000_000;
const DAY = 86400000;

// A row well past the age cutoff and well past the visible-count budget: it
// survives only if one of the exemptions applies.
function staleRow(extra = {}) {
  return { pinned: false, remote: false, sortTime: NOW - 30 * DAY, ...extra };
}
const caps = { count: 99, visibleSessionCount: 25, ageCutoff: NOW - 3 * DAY, isActive: false };

test('a stale local row is truncated', () => {
  assert.strictEqual(rowSurvivesTruncation(staleRow(), TIER_REST, caps), false);
});

test('a remote row survives however old it looks', () => {
  // The regression this guards: a remote session whose tmux session is still
  // running on the host, but whose `modified` has not moved since the user last
  // opened it, was dropped from the list — indistinguishable from archiving.
  assert.strictEqual(rowSurvivesTruncation(staleRow({ remote: true }), TIER_REST, caps), true);
  // Also exempt from the count budget, not just the age cutoff.
  assert.strictEqual(
    rowSurvivesTruncation(staleRow({ remote: true, sortTime: NOW }), TIER_REST, caps), true);
});

test('the existing exemptions still hold', () => {
  assert.strictEqual(rowSurvivesTruncation(staleRow(), TIER_RUNNING, caps), true);
  assert.strictEqual(rowSurvivesTruncation(staleRow({ pinned: true }), TIER_REST, caps), true);
  assert.strictEqual(
    rowSurvivesTruncation(staleRow(), TIER_REST, { ...caps, isActive: true }), true);
});

test('a recent local row survives while there is budget, and not after', () => {
  const recent = staleRow({ sortTime: NOW - DAY });
  assert.strictEqual(rowSurvivesTruncation(recent, TIER_REST, { ...caps, count: 24 }), true);
  // Budget spent: recency alone is not enough.
  assert.strictEqual(rowSurvivesTruncation(recent, TIER_REST, { ...caps, count: 25 }), false);
  // In budget but older than the cutoff: the age check is not enough either.
  assert.strictEqual(rowSurvivesTruncation(staleRow(), TIER_REST, { ...caps, count: 0 }), false);
});

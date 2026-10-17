import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPendingAbandoned, PENDING_GRACE_MS } from '../src/domain/session/pending';
import { sessionTier, TIER_RUNNING, TIER_READY, TIER_REST } from '../src/domain/session/tiers';
import type { PendingSession } from '../src/domain/session/pending';
import type { SessionSignals } from '../src/domain/session/tiers';

const NOW = 1_700_000_000_000;
const PAST_GRACE = PENDING_GRACE_MS + 1000;

// A pending row: the client-side session object the renderer invents at launch,
// before Claude has written any .jsonl for it.
// Only the fields these rules read are filled in, so the fixture is cast rather
// than padded out with a dozen values no assertion depends on.
function pendingRow(
  extra: Partial<PendingSession> = {},
  session: Record<string, unknown> = {},
): PendingSession {
  return {
    projectPath: '/repo',
    folder: '-repo',
    session: { sessionId: 'sid', created: new Date(NOW).toISOString(), archived: 0, ...session },
    ...extra,
  } as PendingSession;
}

// --- Which pending rows are never coming back ---

test('a pending row whose PTY exited long ago is abandoned', () => {
  // The regression: a session launched with a --session-id the CLI then refused
  // exited without ever writing a .jsonl, so the "real session appeared" check
  // could never fire and nothing else evicted it. The row was immortal.
  /* Given */
  const row = pendingRow({ exitedAt: NOW - PAST_GRACE });

  /* When */
  const abandoned = isPendingAbandoned(row, { now: NOW });

  /* Then */
  assert.equal(abandoned, true);
});

test('a pending row is kept through its grace period after exiting', () => {
  /* Given */
  const row = pendingRow({ exitedAt: NOW - 1000 });

  /* When */
  const abandoned = isPendingAbandoned(row, { now: NOW });

  /* Then */
  assert.equal(abandoned, false);
});

test('a running pending row is never abandoned, however old', () => {
  /* Given */
  const old = pendingRow({ exitedAt: NOW - PAST_GRACE }, { created: new Date(NOW - PAST_GRACE).toISOString() });

  /* When */
  const abandoned = isPendingAbandoned(old, { running: true, now: NOW });

  /* Then */
  assert.equal(abandoned, false);
});

test('the row being looked at is kept so its exit banner stays readable', () => {
  /* Given */
  const row = pendingRow({ exitedAt: NOW - PAST_GRACE });

  /* When */
  const abandoned = isPendingAbandoned(row, { onScreen: true, now: NOW });

  /* Then */
  assert.equal(abandoned, false);
});

test('a missed exit event still ages out, counted from creation', () => {
  // No exitedAt: the renderer reloaded mid-launch, or openTerminal failed
  // before any PTY existed. Nothing is running under the id either way.
  /* Given */
  const stale = pendingRow({}, { created: new Date(NOW - PAST_GRACE).toISOString() });

  /* When */
  const abandoned = isPendingAbandoned(stale, { now: NOW });

  /* Then */
  assert.equal(abandoned, true);
});

test('a launch still in flight keeps its grace period', () => {
  /* Given */
  const fresh = pendingRow();

  /* When */
  const abandoned = isPendingAbandoned(fresh, { now: NOW });

  /* Then */
  assert.equal(abandoned, false);
});

test('an unparseable created date does not read as infinitely old', () => {
  /* Given */
  const undated = pendingRow({}, { created: undefined });

  /* When */
  const abandoned = isPendingAbandoned(undated, { now: NOW });

  /* Then */
  assert.equal(abandoned, false);
});

test('terminals and remotes are exempt', () => {
  // Terminals are torn down explicitly on process exit, and a remote row is
  // meant to outlive its connection — archive is the only thing that drops one.
  /* Given */
  const dead = { exitedAt: NOW - PAST_GRACE };

  /* When */
  const terminal = isPendingAbandoned(pendingRow(dead, { type: 'terminal' }), { now: NOW });
  const remote = isPendingAbandoned(pendingRow(dead, { type: 'remote' }), { now: NOW });

  /* Then */
  assert.equal(terminal, false);
  assert.equal(remote, false);
});

// --- Which pending rows are filed under "Working" ---

// The ranking rules take the live signals as an argument, so a scenario is just
// a record rather than a populated pile of module state to clean up afterwards.
function signals(overrides: Partial<SessionSignals> = {}): SessionSignals {
  return {
    needsAttention: false,
    responseReady: false,
    busy: false,
    pending: false,
    hasLivePty: false,
    ...overrides,
  };
}

test('a pending row with a live PTY is Working', () => {
  /* When */
  const tier = sessionTier(signals({ pending: true, hasLivePty: true }));

  /* Then */
  assert.equal(tier, TIER_RUNNING);
});

test('a pending row with no PTY is not Working', () => {
  // Working is exempt from truncation (rowSurvivesTruncation), so tiering a
  // dead placeholder there is what made it impossible to age out of the list.
  /* When */
  const tier = sessionTier(signals({ pending: true }));

  /* Then */
  assert.equal(tier, TIER_REST);
});

test('a live session still outranks a dead one, pending or not', () => {
  /* When */
  const live = sessionTier(signals({ hasLivePty: true }));
  const busy = sessionTier(signals({ busy: true }));
  const dead = sessionTier(signals());

  /* Then */
  assert.equal(live, TIER_READY);
  assert.equal(busy, TIER_RUNNING);
  assert.equal(dead, TIER_REST);
});

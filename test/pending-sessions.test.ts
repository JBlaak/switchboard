import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPendingAbandoned, PENDING_GRACE_MS } from '../src/renderer/utils.js';
import { sessionTier, TIER_RUNNING, TIER_READY, TIER_REST } from '../src/renderer/session-tiers.js';
import {
  attentionSessions, pendingSessions, responseReadySessions, sessionBusyState, state,
} from '../src/renderer/state.js';
import type { PendingSession } from '../src/renderer/state.js';

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
  const row = pendingRow({ exitedAt: NOW - PAST_GRACE });
  assert.equal(isPendingAbandoned(row, { now: NOW }), true);
});

test('a pending row is kept through its grace period after exiting', () => {
  const row = pendingRow({ exitedAt: NOW - 1000 });
  assert.equal(isPendingAbandoned(row, { now: NOW }), false);
});

test('a running pending row is never abandoned, however old', () => {
  const old = pendingRow({ exitedAt: NOW - PAST_GRACE }, { created: new Date(NOW - PAST_GRACE).toISOString() });
  assert.equal(isPendingAbandoned(old, { running: true, now: NOW }), false);
});

test('the row being looked at is kept so its exit banner stays readable', () => {
  const row = pendingRow({ exitedAt: NOW - PAST_GRACE });
  assert.equal(isPendingAbandoned(row, { onScreen: true, now: NOW }), false);
});

test('a missed exit event still ages out, counted from creation', () => {
  // No exitedAt: the renderer reloaded mid-launch, or openTerminal failed
  // before any PTY existed. Nothing is running under the id either way.
  const stale = pendingRow({}, { created: new Date(NOW - PAST_GRACE).toISOString() });
  assert.equal(isPendingAbandoned(stale, { now: NOW }), true);
  // A launch still in flight keeps its grace period.
  const fresh = pendingRow();
  assert.equal(isPendingAbandoned(fresh, { now: NOW }), false);
  // An unparseable created date must not read as "infinitely old".
  const undated = pendingRow({}, { created: undefined });
  assert.equal(isPendingAbandoned(undated, { now: NOW }), false);
});

test('terminals and remotes are exempt', () => {
  // Terminals are torn down explicitly by onProcessExited, and a remote row is
  // meant to outlive its connection — archive is the only thing that drops one.
  const dead = { exitedAt: NOW - PAST_GRACE };
  assert.equal(isPendingAbandoned(pendingRow(dead, { type: 'terminal' }), { now: NOW }), false);
  assert.equal(isPendingAbandoned(pendingRow(dead, { type: 'remote' }), { now: NOW }), false);
});

// --- Which pending rows are filed under "Working" ---

// sessionTier reads the renderer's shared state module. These used to be free
// variables resolving to Node globals, which a test could just assign; now they
// are real exports, so a scenario populates them and clears up afterwards.
function withTierState(
  { busy = false, pending = false, running = false }:
    { busy?: boolean; pending?: boolean; running?: boolean },
  fn: () => number,
): number {
  attentionSessions.clear();
  responseReadySessions.clear();
  sessionBusyState.clear();
  pendingSessions.clear();
  state.activePtyIds = new Set(running ? ['sid'] : []);
  if (busy) sessionBusyState.set('sid', true);
  if (pending) pendingSessions.set('sid', pendingRow());
  try { return fn(); } finally {
    attentionSessions.clear();
    responseReadySessions.clear();
    sessionBusyState.clear();
    pendingSessions.clear();
    state.activePtyIds = new Set();
  }
}

test('a pending row with a live PTY is Working', () => {
  assert.equal(withTierState({ pending: true, running: true }, () => sessionTier('sid')), TIER_RUNNING);
});

test('a pending row with no PTY is not Working', () => {
  // Working is exempt from truncation (rowSurvivesTruncation), so tiering a
  // dead placeholder there is what made it impossible to age out of the list.
  assert.equal(withTierState({ pending: true }, () => sessionTier('sid')), TIER_REST);
});

test('a live session still outranks a dead one, pending or not', () => {
  assert.equal(withTierState({ running: true }, () => sessionTier('sid')), TIER_READY);
  assert.equal(withTierState({ busy: true }, () => sessionTier('sid')), TIER_RUNNING);
  assert.equal(withTierState({}, () => sessionTier('sid')), TIER_REST);
});

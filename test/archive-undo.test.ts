import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  archiveUndoLabel, archiveUndoReducer, initialArchiveUndoState, rekeyArchiveUndo,
} from '../src/renderer/state/archive-undo-slice';
import type { ArchiveUndo, ArchiveUndoState } from '../src/renderer/state/archive-undo-slice';
import { undoArchiveWith } from '../src/renderer/ui/archive-undo/undo';
import type { UndoSteps } from '../src/renderer/ui/archive-undo/undo';
import type { RendererEvent } from '../src/renderer/state/events';

const offered = (sessionIds: string[], extra: Partial<Omit<ArchiveUndo, 'id'>> = {}): RendererEvent => ({
  type: 'archiveUndoOffered',
  undo: { sessionIds, label: '“Fix login”', leavingIds: ['row-s1'], reopen: null, ...extra },
});

/** Steps that record what happened, failing to unarchive the sessions in `failing`. */
function fakeSteps({ failing = [] as string[], offeredSession = null as string | null } = {}) {
  const log: string[] = [];
  const events: RendererEvent[] = [];
  const steps: UndoSteps = {
    dispatch: (event) => { events.push(event); },
    unarchive: async (sessionId) => {
      log.push(`unarchive ${sessionId}`);
      return !failing.includes(sessionId);
    },
    reopen: async (sessionId) => { log.push(`reopen ${sessionId}`); },
    reload: async () => { log.push('reload'); },
    offeredSession: () => offeredSession,
  };
  return { steps, log, events };
}

const undo = (extra: Partial<ArchiveUndo> = {}): ArchiveUndo => ({
  id: 3, sessionIds: ['s1'], label: '“Fix login”', leavingIds: ['row-s1'], reopen: null, ...extra,
});

// ── The slice ──

test('an archive here brings the toast', () => {
  /* When */
  const state = archiveUndoReducer(initialArchiveUndoState, offered(['s1']));

  /* Then */
  assert.deepEqual(state.undo, { id: 1, sessionIds: ['s1'], label: '“Fix login”', leavingIds: ['row-s1'], reopen: null });
});

test('a newer archive replaces the toast, so only the latest can be undone', () => {
  /* Given */
  const first = archiveUndoReducer(initialArchiveUndoState, offered(['s1']));

  /* When */
  const second = archiveUndoReducer(first, offered(['s2']));

  /* Then */
  assert.equal(second.undo?.id, 2);
  assert.deepEqual(second.undo?.sessionIds, ['s2']);
});

test('an archive that archived nothing brings no toast', () => {
  /* When */
  const state = archiveUndoReducer(initialArchiveUndoState, offered([]));

  /* Then */
  assert.equal(state, initialArchiveUndoState);
});

test('closing the toast puts it away', () => {
  /* Given */
  const shown = archiveUndoReducer(initialArchiveUndoState, offered(['s1']));

  /* When */
  const state = archiveUndoReducer(shown, { type: 'archiveUndoClosed', id: 1 });

  /* Then */
  assert.equal(state.undo, null);
});

test("an older toast's timer leaves a newer toast up", () => {
  /* Given */
  const first = archiveUndoReducer(initialArchiveUndoState, offered(['s1']));
  const second = archiveUndoReducer(first, offered(['s2']));

  /* When */
  const state = archiveUndoReducer(second, { type: 'archiveUndoClosed', id: 1 });

  /* Then */
  assert.equal(state, second);
});

test('a re-keyed session stays undoable under its new id', () => {
  /* Given */
  const state: ArchiveUndoState = { undo: undo({ sessionIds: ['s1', 's2'], reopen: 's1' }), nextId: 4 };

  /* When */
  const rekeyed = rekeyArchiveUndo(state, 's1', 's9');

  /* Then */
  assert.deepEqual(rekeyed.undo?.sessionIds, ['s9', 's2']);
  assert.equal(rekeyed.undo?.reopen, 's9');
  assert.equal(rekeyArchiveUndo(state, 'other', 's9'), state);
});

test("the toast names one session, and counts several", () => {
  /* Then */
  assert.equal(archiveUndoLabel(['Fix login']), '“Fix login”');
  assert.equal(archiveUndoLabel(['a', 'b', 'c', 'd']), '4 sessions');
});

// ── Undo ──

test('Undo closes the toast, brings the rows back and reloads the list', async () => {
  /* Given */
  const { steps, log, events } = fakeSteps();

  /* When */
  await undoArchiveWith(steps, undo());

  /* Then */
  assert.deepEqual(log, ['unarchive s1', 'reload']);
  assert.deepEqual(events, [
    { type: 'archiveUndoClosed', id: 3 },
    { type: 'rowLeaving', id: 'row-s1', leaving: false },
  ]);
});

test('Undo of a group brings every session in it back', async () => {
  /* Given */
  const { steps, log } = fakeSteps();

  /* When */
  await undoArchiveWith(steps, undo({ sessionIds: ['s1', 's2', 's3'], leavingIds: ['group-x'] }));

  /* Then */
  assert.deepEqual(log, ['unarchive s1', 'unarchive s2', 'unarchive s3', 'reload']);
});

test('the session that was on screen opens again after the reload', async () => {
  /* Given */
  const { steps, log } = fakeSteps();

  /* When */
  await undoArchiveWith(steps, undo({ reopen: 's1' }));

  /* Then */
  assert.deepEqual(log, ['unarchive s1', 'reload', 'reopen s1']);
});

test('a session that could not be unarchived is not opened', async () => {
  /* Given */
  const { steps, log } = fakeSteps({ failing: ['s1'] });

  /* When */
  await undoArchiveWith(steps, undo({ reopen: 's1' }));

  /* Then */
  assert.deepEqual(log, ['unarchive s1', 'reload']);
});

test("Undo puts away the Mark done offer about a session it brings back", async () => {
  /* Given */
  const { steps, events } = fakeSteps({ offeredSession: 's1' });

  /* When */
  await undoArchiveWith(steps, undo());

  /* Then */
  assert.ok(events.some(e => e.type === 'sessionTaskOfferClosed'));
});

test("Undo leaves the Mark done offer about another session up", async () => {
  /* Given */
  const { steps, events } = fakeSteps({ offeredSession: 'other' });

  /* When */
  await undoArchiveWith(steps, undo());

  /* Then */
  assert.ok(!events.some(e => e.type === 'sessionTaskOfferClosed'));
});

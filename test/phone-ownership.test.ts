import { test } from 'node:test';
import assert from 'node:assert';
import {
  acceptsInput, applyOwnership, lastSizeOf, MAC, NO_OWNERSHIP, ownerOf, viewFor,
  type OwnershipEvent, type OwnershipState,
} from '../src/domain/phone/ownership';

const PHONE = 'device-pixel';
const OTHER_PHONE = 'device-tablet';
const MAC_SIZE = { cols: 160, rows: 48 };
const PHONE_SIZE = { cols: 48, rows: 30 };

/** Apply events in order and return the final state. */
function after(events: OwnershipEvent[], state: OwnershipState = NO_OWNERSHIP): OwnershipState {
  return events.reduce((s, event) => applyOwnership(s, event).state, state);
}

/** The Mac has the session open, and the phone has reported its size for it. */
function bothSized(sessionId = 's1'): OwnershipState {
  return after([
    { type: 'size', sessionId, device: MAC, size: MAC_SIZE },
    { type: 'size', sessionId, device: PHONE, size: PHONE_SIZE },
  ]);
}

test('a session nothing happened to belongs to the Mac', () => {
  /* When */
  const owner = ownerOf(NO_OWNERSHIP, 's1');

  /* Then */
  assert.strictEqual(owner, MAC);
  assert.strictEqual(viewFor(NO_OWNERSHIP, 's1', MAC), 'terminal');
  assert.strictEqual(viewFor(NO_OWNERSHIP, 's1', PHONE), 'elsewhere');
  assert.ok(acceptsInput(NO_OWNERSHIP, 's1', MAC));
  assert.ok(!acceptsInput(NO_OWNERSHIP, 's1', PHONE));
});

test("the owner's size report resizes the PTY, once per size", () => {
  /* Given */
  const first = applyOwnership(NO_OWNERSHIP, { type: 'size', sessionId: 's1', device: MAC, size: MAC_SIZE });

  /* When */
  const same = applyOwnership(first.state, { type: 'size', sessionId: 's1', device: MAC, size: { ...MAC_SIZE } });
  const bigger = applyOwnership(same.state, { type: 'size', sessionId: 's1', device: MAC, size: { cols: 200, rows: 50 } });

  /* Then */
  assert.deepStrictEqual(first.resize, { s1: MAC_SIZE });
  assert.deepStrictEqual(same.resize, {});
  assert.deepStrictEqual(bigger.resize, { s1: { cols: 200, rows: 50 } });
});

test('a size report or attach from a device that is not active neither resizes nor moves ownership', () => {
  /* Given */
  const state = after([{ type: 'size', sessionId: 's1', device: MAC, size: MAC_SIZE }]);

  /* When */
  const change = applyOwnership(state, { type: 'size', sessionId: 's1', device: PHONE, size: PHONE_SIZE });

  /* Then */
  assert.deepStrictEqual(change.resize, {});
  assert.deepStrictEqual(change.ownerChanged, []);
  assert.strictEqual(ownerOf(change.state, 's1'), MAC);
});

test("Use here moves ownership and resizes the PTY to the device's last size", () => {
  /* Given */
  const state = bothSized();

  /* When */
  const change = applyOwnership(state, { type: 'use-here', sessionId: 's1', device: PHONE });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 's1'), PHONE);
  assert.deepStrictEqual(change.ownerChanged, ['s1']);
  assert.deepStrictEqual(change.resize, { s1: PHONE_SIZE });
  assert.strictEqual(viewFor(change.state, 's1', PHONE), 'terminal');
  assert.strictEqual(viewFor(change.state, 's1', MAC), 'elsewhere');
  assert.ok(acceptsInput(change.state, 's1', PHONE));
  assert.ok(!acceptsInput(change.state, 's1', MAC));
});

test('Use here on the Mac takes the session back at the Mac size', () => {
  /* Given */
  const state = after([{ type: 'use-here', sessionId: 's1', device: PHONE }], bothSized());

  /* When */
  const change = applyOwnership(state, { type: 'use-here', sessionId: 's1', device: MAC });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 's1'), MAC);
  assert.deepStrictEqual(change.resize, { s1: MAC_SIZE });
});

test('Use here from a device with no known size moves ownership and leaves the PTY until it reports one', () => {
  /* Given */
  const state = after([{ type: 'size', sessionId: 's1', device: MAC, size: MAC_SIZE }]);

  /* When */
  const moved = applyOwnership(state, { type: 'use-here', sessionId: 's1', device: PHONE });
  const sized = applyOwnership(moved.state, { type: 'size', sessionId: 's1', device: PHONE, size: PHONE_SIZE });

  /* Then */
  assert.strictEqual(ownerOf(moved.state, 's1'), PHONE);
  assert.deepStrictEqual(moved.resize, {});
  assert.deepStrictEqual(sized.resize, { s1: PHONE_SIZE });
});

test('Use here on the device that already owns the session changes nothing', () => {
  /* Given */
  const state = bothSized();

  /* When */
  const change = applyOwnership(state, { type: 'use-here', sessionId: 's1', device: MAC });

  /* Then */
  assert.deepStrictEqual(change.ownerChanged, []);
  assert.deepStrictEqual(change.resize, {});
  assert.strictEqual(change.state, state);
});

test('an answer from a device makes it the active one, both ways', () => {
  /* Given */
  const state = bothSized();

  /* When */
  const onPhone = applyOwnership(state, { type: 'answered', sessionId: 's1', device: PHONE });
  const onMac = applyOwnership(onPhone.state, { type: 'answered', sessionId: 's1', device: MAC });

  /* Then */
  assert.strictEqual(ownerOf(onPhone.state, 's1'), PHONE);
  assert.deepStrictEqual(onPhone.resize, { s1: PHONE_SIZE });
  assert.strictEqual(ownerOf(onMac.state, 's1'), MAC);
  assert.deepStrictEqual(onMac.resize, { s1: MAC_SIZE });
});

test('a phone that disconnects keeps its sessions until Use here on the Mac', () => {
  /* Given */
  const state = after([{ type: 'use-here', sessionId: 's1', device: PHONE }], bothSized());

  /* When */
  const left = applyOwnership(state, { type: 'device-left', device: PHONE });

  /* Then */
  assert.strictEqual(ownerOf(left.state, 's1'), PHONE);
  assert.deepStrictEqual(left.resize, {});
  assert.deepStrictEqual(left.ownerChanged, []);
  assert.ok(!acceptsInput(left.state, 's1', MAC));
});

test('ownership never moves on a size report, a disconnect or an attach', () => {
  /* Given */
  const phoneOwns = after([{ type: 'use-here', sessionId: 's1', device: PHONE }], bothSized());
  const passing: OwnershipEvent[] = [
    { type: 'size', sessionId: 's1', device: MAC, size: { cols: 100, rows: 40 } },
    { type: 'size', sessionId: 's1', device: OTHER_PHONE, size: { cols: 60, rows: 40 } },
    { type: 'device-left', device: PHONE },
    { type: 'device-left', device: MAC },
    { type: 'size', sessionId: 's1', device: PHONE, size: { cols: 50, rows: 31 } },
  ];

  /* When */
  const changes = passing.map((event) => applyOwnership(phoneOwns, event));

  /* Then */
  for (const change of changes) {
    assert.strictEqual(ownerOf(change.state, 's1'), PHONE);
    assert.deepStrictEqual(change.ownerChanged, []);
  }
});

test('the PTY only ever takes sizes from the device that owns it', () => {
  /* Given */
  const phoneOwns = after([{ type: 'use-here', sessionId: 's1', device: PHONE }], bothSized());

  /* When */
  const macResize = applyOwnership(phoneOwns, { type: 'size', sessionId: 's1', device: MAC, size: { cols: 100, rows: 40 } });
  const phoneRotates = applyOwnership(macResize.state, { type: 'size', sessionId: 's1', device: PHONE, size: { cols: 90, rows: 20 } });
  const back = applyOwnership(phoneRotates.state, { type: 'use-here', sessionId: 's1', device: MAC });

  /* Then */
  assert.deepStrictEqual(macResize.resize, {});
  assert.deepStrictEqual(phoneRotates.resize, { s1: { cols: 90, rows: 20 } });
  assert.deepStrictEqual(back.resize, { s1: { cols: 100, rows: 40 } }, 'the Mac size reported while it was not active');
});

test('one session moving leaves the others where they are', () => {
  /* Given */
  const state = after([{ type: 'size', sessionId: 's2', device: MAC, size: MAC_SIZE }], bothSized('s1'));

  /* When */
  const change = applyOwnership(state, { type: 'use-here', sessionId: 's1', device: PHONE });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 's2'), MAC);
  assert.deepStrictEqual(Object.keys(change.resize), ['s1']);
});

test('a session started from a phone belongs to it from the start, at its size', () => {
  /* When */
  const change = applyOwnership(NO_OWNERSHIP, { type: 'started', sessionId: 'new', device: PHONE, size: PHONE_SIZE });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 'new'), PHONE);
  assert.deepStrictEqual(change.ownerChanged, ['new']);
  assert.deepStrictEqual(change.resize, { new: PHONE_SIZE });
  assert.strictEqual(viewFor(change.state, 'new', MAC), 'elsewhere');
});

test("a session started from a phone without a size takes the phone's last size for any session", () => {
  /* Given */
  const state = after([{ type: 'size', sessionId: 'other', device: PHONE, size: { cols: 44, rows: 28 } }]);

  /* When */
  const change = applyOwnership(state, { type: 'started', sessionId: 'new', device: PHONE });

  /* Then */
  assert.deepStrictEqual(lastSizeOf(state, PHONE), { cols: 44, rows: 28 });
  assert.strictEqual(ownerOf(change.state, 'new'), PHONE);
  assert.deepStrictEqual(change.resize, { new: { cols: 44, rows: 28 } });
});

test('a device that never reported a size has no last size', () => {
  /* When */
  const size = lastSizeOf(NO_OWNERSHIP, PHONE);

  /* Then */
  assert.strictEqual(size, null);
});

test('a re-keyed session keeps its owner and sizes under the new id', () => {
  /* Given */
  const state = after([{ type: 'use-here', sessionId: 'old', device: PHONE }], bothSized('old'));

  /* When */
  const change = applyOwnership(state, { type: 'rekeyed', from: 'old', to: 'new' });
  const back = applyOwnership(change.state, { type: 'use-here', sessionId: 'new', device: MAC });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 'new'), PHONE);
  assert.strictEqual(ownerOf(change.state, 'old'), MAC, 'the old id is forgotten');
  assert.deepStrictEqual(change.resize, {});
  assert.deepStrictEqual(back.resize, { new: MAC_SIZE });
});

test('re-keying a session nothing happened to changes nothing', () => {
  /* When */
  const change = applyOwnership(NO_OWNERSHIP, { type: 'rekeyed', from: 'a', to: 'b' });

  /* Then */
  assert.strictEqual(change.state, NO_OWNERSHIP);
});

test('an ended session is forgotten', () => {
  /* Given */
  const state = after([{ type: 'use-here', sessionId: 's1', device: PHONE }], bothSized());

  /* When */
  const change = applyOwnership(state, { type: 'ended', sessionId: 's1' });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 's1'), MAC);
  assert.deepStrictEqual(change.state.sessions, {});
  assert.deepStrictEqual(change.ownerChanged, []);
});

test("a revoked device's sessions go back to the Mac at the Mac size", () => {
  /* Given */
  const state = after([
    { type: 'use-here', sessionId: 's1', device: PHONE },
    { type: 'size', sessionId: 's2', device: OTHER_PHONE, size: { cols: 70, rows: 40 } },
    { type: 'use-here', sessionId: 's2', device: OTHER_PHONE },
    { type: 'started', sessionId: 's3', device: PHONE, size: PHONE_SIZE },
  ], bothSized('s1'));

  /* When */
  const change = applyOwnership(state, { type: 'device-removed', device: PHONE });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 's1'), MAC);
  assert.strictEqual(ownerOf(change.state, 's2'), OTHER_PHONE);
  assert.strictEqual(ownerOf(change.state, 's3'), MAC);
  assert.deepStrictEqual(change.ownerChanged.sort(), ['s1', 's3']);
  assert.deepStrictEqual(change.resize, { s1: MAC_SIZE }, 's3 waits for the Mac to report a size');
  assert.strictEqual(lastSizeOf(change.state, PHONE), null);
});

test('a device taking over from another device', () => {
  /* Given */
  const state = after([
    { type: 'size', sessionId: 's1', device: OTHER_PHONE, size: { cols: 70, rows: 40 } },
    { type: 'use-here', sessionId: 's1', device: PHONE },
  ], bothSized());

  /* When */
  const change = applyOwnership(state, { type: 'use-here', sessionId: 's1', device: OTHER_PHONE });

  /* Then */
  assert.strictEqual(ownerOf(change.state, 's1'), OTHER_PHONE);
  assert.strictEqual(viewFor(change.state, 's1', PHONE), 'elsewhere');
  assert.deepStrictEqual(change.resize, { s1: { cols: 70, rows: 40 } });
});

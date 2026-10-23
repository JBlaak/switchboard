import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHONE_ACCESS_OFF } from '../src/domain/phone/state';
import { initialRendererState, rekeyState, rootReducer } from '../src/renderer/state/root';
import {
  answeredOnPhone, confirmShownIn, deviceOwnerIn, phoneIndicatorIn, switchShownIn,
} from '../src/renderer/state/phone-access-slice';
import {
  deviceLine, failureLine, listeningLine, pairingTimeLeft, placeholderCopy, timeAgo,
} from '../src/renderer/ui/phone-access/phone-access-copy';
import type { PhoneAccessState, PhoneDeviceView } from '../src/domain/phone/state';
import type { QuestionsSettled } from '../src/domain/questions/question';
import type { RendererEvent } from '../src/renderer/state/events';
import type { RendererState } from '../src/renderer/state/root';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
  return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const pixel: PhoneDeviceView = {
  id: 'd1', name: 'Pixel 9 Pro', pairedAt: NOW - 0.5 * DAY, lastSeenAt: NOW, connected: true,
};
const tablet: PhoneDeviceView = {
  id: 'd2', name: 'Pixel Tablet', pairedAt: Date.UTC(2026, 9, 2, 12), lastSeenAt: NOW - 4 * DAY, connected: false,
};

/** Phone access on and listening, two phones paired and the first one connected. */
const LISTENING: PhoneAccessState = {
  ...PHONE_ACCESS_OFF,
  enabled: true,
  listening: true,
  host: 'joris-mbp.local',
  port: 48231,
  devices: [pixel, tablet],
};

const changed = (state: PhoneAccessState): RendererEvent => ({ type: 'phoneAccessChanged', state });
const onPixel = { kind: 'device', deviceId: 'd1', name: 'Pixel 9 Pro' } as const;

// ── The snapshot ──

test('until main says anything, Phone access shows as off', () => {
  /* When */
  const state = initialRendererState();

  /* Then */
  assert.deepEqual(state.phoneAccess.access, PHONE_ACCESS_OFF);
  assert.equal(phoneIndicatorIn(state.phoneAccess.access), null);
  assert.equal(listeningLine(state.phoneAccess.access), null);
  assert.equal(switchShownIn(state.phoneAccess), false);
});

test('the switch shows where it was flipped while main answers, then where main says it ended', () => {
  /* Given */
  const start = initialRendererState();

  /* When */
  const flipped = run(start, { type: 'phoneAccessSwitched', enabled: true });

  /* Then */
  assert.equal(switchShownIn(flipped.phoneAccess), true);
  assert.equal(flipped.phoneAccess.access.enabled, false);

  /* When */
  const answered = run(flipped, changed({ ...LISTENING, listening: false, error: 'Port 48231 is in use' }));

  /* Then */
  assert.equal(switchShownIn(answered.phoneAccess), true);
  assert.equal(answered.phoneAccess.switchedTo, null);
  assert.deepEqual(listeningLine(answered.phoneAccess.access), { kind: 'failed', message: 'Port 48231 is in use' });
});

test('a failed call puts the switch back and is shown until main next answers', () => {
  /* Given */
  const flipped = run(initialRendererState(), { type: 'phoneAccessSwitched', enabled: true });

  /* When */
  const failed = run(flipped, { type: 'phoneAccessCallFailed', call: 'enable', message: 'No handler registered for \'phone-access:set-enabled\'' });

  /* Then */
  assert.equal(switchShownIn(failed.phoneAccess), false);
  assert.equal(failureLine(failed.phoneAccess.failure!), 'Couldn\'t turn Phone access on: No handler registered for \'phone-access:set-enabled\'');

  /* When */
  const answered = run(failed, changed(LISTENING));

  /* Then */
  assert.equal(answered.phoneAccess.failure, null);
});

test('the same snapshot again changes nothing', () => {
  /* Given */
  const state = run(initialRendererState(), changed(LISTENING));

  /* When */
  const again = run(state, changed(LISTENING));

  /* Then */
  assert.equal(again, state);
});

// ── The listening line and the toolbar indicator ──

test('the listening line names the host and the connected phone, or says it is starting', () => {
  /* When */
  const listening = listeningLine(LISTENING);
  const alone = listeningLine({ ...LISTENING, devices: [tablet] });
  const starting = listeningLine({ ...LISTENING, listening: false, host: null });

  /* Then */
  assert.deepEqual(listening, { kind: 'listening', host: 'joris-mbp.local', connected: 'Pixel 9 Pro connected' });
  assert.deepEqual(alone, { kind: 'listening', host: 'joris-mbp.local', connected: null });
  assert.deepEqual(starting, { kind: 'starting' });
});

test('the indicator is absent while off, "On" while no phone is connected, and the phone\'s name while one is', () => {
  /* When */
  const off = phoneIndicatorIn(PHONE_ACCESS_OFF);
  const on = phoneIndicatorIn({ ...LISTENING, devices: [tablet] });
  const connected = phoneIndicatorIn(LISTENING);
  const two = phoneIndicatorIn({ ...LISTENING, devices: [pixel, { ...tablet, connected: true }] });

  /* Then */
  assert.equal(off, null);
  assert.deepEqual(on, { connected: false, label: 'On', title: 'Phone access is on, no phone connected' });
  assert.equal(connected?.connected, true);
  assert.equal(connected?.label, 'Pixel 9 Pro');
  assert.equal(two?.label, 'Pixel 9 Pro +1');
});

// ── Pairing ──

test('the pairing code counts down in minutes and seconds, and is gone once it runs out', () => {
  /* Given */
  const expiresAt = NOW + 102_000;

  /* When */
  const left = [NOW, NOW + 500, expiresAt - 9_000, expiresAt, expiresAt + 1].map(now => pairingTimeLeft(expiresAt, now));

  /* Then */
  assert.deepEqual(left, ['1:42', '1:42', '0:09', null, null]);
});

test('the confirm dialog shows for a waiting phone, steps aside once answered, and comes back if the answer failed', () => {
  /* Given */
  const waiting = run(initialRendererState(), changed({ ...LISTENING, confirm: { requestId: 'r1', deviceName: 'Pixel 9 Pro' } }));

  /* Then */
  assert.deepEqual(confirmShownIn(waiting.phoneAccess), { requestId: 'r1', deviceName: 'Pixel 9 Pro' });

  /* When */
  const answered = run(waiting, { type: 'phonePairingAnswered', requestId: 'r1' });

  /* Then */
  assert.equal(confirmShownIn(answered.phoneAccess), null);

  /* When */
  const failed = run(answered, { type: 'phoneAccessCallFailed', call: 'confirm', message: 'gone' });

  /* Then */
  assert.equal(confirmShownIn(failed.phoneAccess)?.requestId, 'r1');

  /* When */
  const next = run(answered, changed({ ...LISTENING, confirm: { requestId: 'r2', deviceName: 'Pixel 8' } }));

  /* Then */
  assert.equal(confirmShownIn(next.phoneAccess)?.deviceName, 'Pixel 8');
});

// ── Paired phones ──

test('a paired phone says when it was paired, and that it is connected or when it was last seen', () => {
  /* When */
  const connected = deviceLine(pixel, NOW);
  const away = deviceLine(tablet, NOW);
  const never = deviceLine({ ...tablet, lastSeenAt: null }, NOW);

  /* Then */
  assert.deepEqual(connected, { paired: 'Paired 23 Oct', seen: 'Connected now', connected: true });
  assert.deepEqual(away, { paired: 'Paired 2 Oct', seen: 'Last seen 4 days ago', connected: false });
  assert.equal(never.seen, 'Never connected');
});

test('"last seen" reads in minutes, hours and days, then as a date', () => {
  /* When */
  const ago = [NOW - 20_000, NOW - MINUTE, NOW - 12 * MINUTE, NOW - 3 * 60 * MINUTE, NOW - DAY, NOW - 20 * DAY]
    .map(at => timeAgo(at, NOW));

  /* Then */
  assert.deepEqual(ago, ['just now', '1 minute ago', '12 minutes ago', '3 hours ago', '1 day ago', 'on 3 Oct']);
});

// ── Terminal owners ──

test('a session is the Mac\'s unless main said a phone has it', () => {
  /* Given */
  const start = initialRendererState();

  /* When */
  const loaded = run(start, { type: 'terminalOwnersLoaded', owners: { s1: onPixel, s2: { kind: 'mac' } } });

  /* Then */
  assert.deepEqual(deviceOwnerIn(loaded.phoneAccess, 's1'), onPixel);
  assert.equal(deviceOwnerIn(loaded.phoneAccess, 's2'), null);
  assert.equal(deviceOwnerIn(loaded.phoneAccess, 's3'), null);
  assert.equal(deviceOwnerIn(loaded.phoneAccess, null), null);
});

test('an owner push moves a session to a phone and back', () => {
  /* Given */
  const start = initialRendererState();

  /* When */
  const taken = run(start, { type: 'terminalOwnerChanged', sessionId: 's1', owner: onPixel });

  /* Then */
  assert.equal(deviceOwnerIn(taken.phoneAccess, 's1')?.name, 'Pixel 9 Pro');

  /* When */
  const same = run(taken, { type: 'terminalOwnerChanged', sessionId: 's1', owner: { ...onPixel } });
  const back = run(taken, { type: 'terminalOwnerChanged', sessionId: 's1', owner: { kind: 'mac' } });

  /* Then */
  assert.equal(same, taken);
  assert.equal(deviceOwnerIn(back.phoneAccess, 's1'), null);
  assert.deepEqual(back.phoneAccess.owners, {});
});

test('a re-keyed session stays on the phone that has it', () => {
  /* Given */
  const taken = run(initialRendererState(), { type: 'terminalOwnerChanged', sessionId: 'old', owner: onPixel });

  /* When */
  const rekeyed = rekeyState(taken, 'old', 'new');

  /* Then */
  assert.equal(deviceOwnerIn(rekeyed.phoneAccess, 'old'), null);
  assert.deepEqual(deviceOwnerIn(rekeyed.phoneAccess, 'new'), onPixel);
});

test('the placeholder names the phone, and says since when once the phone has gone', () => {
  /* When */
  const connected = placeholderCopy(onPixel, LISTENING, NOW);
  const gone = placeholderCopy(onPixel, { ...LISTENING, devices: [{ ...pixel, connected: false, lastSeenAt: NOW - 12 * MINUTE }] }, NOW);

  /* Then */
  assert.equal(connected.title, 'Active on Pixel 9 Pro');
  assert.equal(connected.note, null);
  assert.equal(gone.note, 'Pixel 9 Pro disconnected 12 minutes ago. The session stays sized for it until you take it back.');
});

// ── Answered on phone ──

test('"Answered on phone" is for a set the session on screen was showing, answered from a phone', () => {
  /* Given */
  const asked = run(initialRendererState(), {
    type: 'questionsAsked',
    pending: { sessionId: 's1', toolUseId: 't1', source: 'ask', questions: [], askedAt: NOW, deadline: null },
  });

  const settled = (rest: Partial<QuestionsSettled>): QuestionsSettled =>
    ({ sessionId: 's1', toolUseId: 't1', outcome: 'answered', ...rest });

  /* When */
  const fromPhone = answeredOnPhone(settled({ answeredOn: 'phone' }), asked.questions, 's1');
  const fromMac = answeredOnPhone(settled({ answeredOn: 'mac' }), asked.questions, 's1');
  const offScreen = answeredOnPhone(settled({ answeredOn: 'phone' }), asked.questions, 's2');
  const withdrawn = answeredOnPhone(settled({ outcome: 'withdrawn' }), asked.questions, 's1');

  /* Then */
  assert.equal(fromPhone, true);
  assert.equal(fromMac, false);
  assert.equal(offScreen, false);
  assert.equal(withdrawn, false);
});

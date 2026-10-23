import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PHONE_ACCESS_OFF } from '../src/domain/phone/state';
import { dispatch, getState } from '../src/renderer/state/app-store';
import { deviceOwnerIn } from '../src/renderer/state/phone-access-slice';
import {
  callErrorMessage, confirmPairing, loadPhoneAccess, loadTerminalOwners, resetIdentity, revokeDevice,
  setPhoneAccessEnabled, startPairing, stopPairing, useTerminalHere,
} from '../src/renderer/ui/phone-access/actions';
import type { PhoneAccessState, PhoneDeviceView } from '../src/domain/phone/state';

// The actions read and write the app's one store; each test starts it from
// Phone access off and owned by nobody but the Mac.

const ON: PhoneAccessState = { ...PHONE_ACCESS_OFF, enabled: true, listening: true, host: 'joris-mbp.local', port: 48231 };
const pixel: PhoneDeviceView = { id: 'd1', name: 'Pixel 9 Pro', pairedAt: 0, lastSeenAt: null, connected: true };

/** A main that answers every Phone access call with `answer`, recording each. */
function installMain(answer: (method: string, args: unknown[]) => Promise<unknown>): { calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  const api = new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) => {
      calls.push([method, ...args]);
      return answer(method, args);
    },
  });
  Object.assign(globalThis, { window: { api } });
  return { calls };
}

const answering = (state: PhoneAccessState) => installMain(async () => state);
const settle = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  dispatch({ type: 'phoneAccessChanged', state: PHONE_ACCESS_OFF });
  dispatch({ type: 'terminalOwnersLoaded', owners: {} });
});

test('each control calls its method on main, and main\'s answer is what shows', async () => {
  /* Given */
  const main = answering(ON);

  /* When */
  await setPhoneAccessEnabled(true);
  await startPairing();
  await stopPairing();
  await confirmPairing('r1', true);
  await confirmPairing('r2', false);

  /* Then */
  assert.deepEqual(main.calls, [
    ['setPhoneAccessEnabled', true],
    ['startPhonePairing'],
    ['stopPhonePairing'],
    ['confirmPhonePairing', 'r1', true],
    ['confirmPhonePairing', 'r2', false],
  ]);
  assert.equal(getState().phoneAccess.access, ON);
});

test('revoke and reset ask first, and do nothing when the answer is no', async () => {
  /* Given */
  const main = answering(ON);
  const asked: string[] = [];
  const no = (prompt: string) => { asked.push(prompt); return false; };
  const yes = (prompt: string) => { asked.push(prompt); return true; };

  /* When */
  await revokeDevice(pixel, no);
  await resetIdentity(no);

  /* Then */
  assert.equal(main.calls.length, 0);
  assert.equal(asked.length, 2);
  assert.match(asked[0], /Revoke “Pixel 9 Pro”\?/);
  assert.match(asked[1], /un-pairs every phone/);

  /* When */
  await revokeDevice(pixel, yes);
  await resetIdentity(yes);

  /* Then */
  assert.deepEqual(main.calls, [['revokePhoneDevice', 'd1'], ['resetPhoneIdentity']]);
});

test('a call main has no handler for shows why, without Electron\'s wrapping', async () => {
  /* Given */
  installMain(async (method) => {
    throw new Error(`Error invoking remote method 'phone-access:${method}': Error: No handler registered for 'phone-access:${method}'`);
  });

  /* When */
  await setPhoneAccessEnabled(true);

  /* Then */
  const { failure, access, switchedTo } = getState().phoneAccess;
  assert.deepEqual(failure, { call: 'enable', message: 'No handler registered for \'phone-access:setPhoneAccessEnabled\'' });
  assert.equal(access.enabled, false);
  assert.equal(switchedTo, null);
});

test('a call that never answers leaves the switch where it was flipped, and the rest as it was', async () => {
  /* Given */
  installMain(() => new Promise(() => {}));

  /* When */
  void setPhoneAccessEnabled(true);
  await settle();

  /* Then */
  assert.equal(getState().phoneAccess.switchedTo, true);
  assert.equal(getState().phoneAccess.access, PHONE_ACCESS_OFF);
  assert.equal(getState().phoneAccess.failure, null);
});

test('loading at launch is quiet when main cannot answer, and takes the snapshot and owners when it can', async () => {
  /* Given */
  installMain(async () => { throw new Error('No handler registered'); });

  /* When */
  await loadPhoneAccess();
  await loadTerminalOwners();

  /* Then */
  assert.equal(getState().phoneAccess.access, PHONE_ACCESS_OFF);
  assert.equal(getState().phoneAccess.failure, null);

  /* Given */
  installMain(async (method) => (method === 'getTerminalOwners'
    ? { s1: { kind: 'device', deviceId: 'd1', name: 'Pixel 9 Pro' } }
    : ON));

  /* When */
  await loadPhoneAccess();
  await loadTerminalOwners();

  /* Then */
  assert.equal(getState().phoneAccess.access, ON);
  assert.equal(deviceOwnerIn(getState().phoneAccess, 's1')?.name, 'Pixel 9 Pro');
});

test('Use here gives the terminal back once main says yes, and says why when it says no', async () => {
  /* Given */
  dispatch({ type: 'terminalOwnerChanged', sessionId: 's1', owner: { kind: 'device', deviceId: 'd1', name: 'Pixel 9 Pro' } });
  const main = installMain(async () => ({ ok: false, error: 'The session has ended' }));

  /* When */
  await useTerminalHere('s1');

  /* Then */
  assert.deepEqual(main.calls, [['useTerminalHere', 's1']]);
  assert.notEqual(deviceOwnerIn(getState().phoneAccess, 's1'), null);
  assert.deepEqual(getState().phoneAccess.failure, { call: 'useHere', message: 'The session has ended' });

  /* Given */
  installMain(async () => ({ ok: true }));

  /* When */
  await useTerminalHere('s1');

  /* Then */
  assert.equal(deviceOwnerIn(getState().phoneAccess, 's1'), null);
});

test('callErrorMessage keeps a plain error as it is', () => {
  /* When */
  const plain = callErrorMessage(new Error('Port 48231 is in use'));
  const nothing = callErrorMessage(undefined);

  /* Then */
  assert.equal(plain, 'Port 48231 is in use');
  assert.equal(nothing, '');
});

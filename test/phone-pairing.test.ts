import { test } from 'node:test';
import assert from 'node:assert';
import {
  attemptPairing, isPairingCodeShape, isPairingOpen, pairingCodeFromBytes, PAIRING_CODE_ALPHABET,
  PAIRING_CODE_TTL_MS, PAIRING_IDLE, PAIRING_LOCKOUT_MS, PAIRING_MAX_FAILURES, startPairing, stopPairing,
  type PairingState,
} from '../src/domain/phone/pairing';

const T0 = 1_700_000_000_000;
const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);

function live(now = T0): { state: PairingState; code: string } {
  const state = startPairing(PAIRING_IDLE, BYTES, now);
  return { state, code: state.kind === 'live' ? state.code : '' };
}

function wrongTimes(state: PairingState, times: number, now: number): PairingState {
  for (let i = 0; i < times; i++) state = attemptPairing(state, 'WRONGWRG', now).state;
  return state;
}

test('a code is eight characters from the unambiguous alphabet, one per random byte', () => {
  /* Given */
  const bytes = new Uint8Array([0, 31, 32, 255, 8, 9, 100, 200]);

  /* When */
  const code = pairingCodeFromBytes(bytes);

  /* Then */
  assert.strictEqual(code, '2Z2Z' + PAIRING_CODE_ALPHABET[8] + PAIRING_CODE_ALPHABET[9] + PAIRING_CODE_ALPHABET[100 & 31] + PAIRING_CODE_ALPHABET[200 & 31]);
  assert.ok(isPairingCodeShape(code));
  for (const ambiguous of ['0', 'O', '1', 'I']) assert.ok(!PAIRING_CODE_ALPHABET.includes(ambiguous));
  assert.strictEqual(new Set(PAIRING_CODE_ALPHABET).size, 32);
});

test('a code needs eight random bytes', () => {
  /* Given */
  const tooFew = new Uint8Array(7);

  /* When */
  const make = () => pairingCodeFromBytes(tooFew);

  /* Then */
  assert.throws(make);
});

test('isPairingCodeShape refuses wrong lengths and characters', () => {
  /* When */
  const results = ['ABCDEFG', 'ABCDEFGHJ', 'ABCDEFG0', 'abcdefgh', 'ABCDEFGH'].map(isPairingCodeShape);

  /* Then */
  assert.deepStrictEqual(results, [false, false, false, false, true]);
});

test('the right code works once', () => {
  /* Given */
  const { state, code } = live();

  /* When */
  const first = attemptPairing(state, code, T0 + 1000);
  const second = attemptPairing(first.state, code, T0 + 2000);

  /* Then */
  assert.strictEqual(first.verdict, 'ok');
  assert.strictEqual(second.verdict, 'not-pairing');
  assert.ok(!isPairingOpen(first.state, T0 + 2000));
});

test('the code stops working after two minutes', () => {
  /* Given */
  const { state, code } = live();

  /* When */
  const justBefore = attemptPairing(state, code, T0 + PAIRING_CODE_TTL_MS - 1);
  const atExpiry = attemptPairing(state, code, T0 + PAIRING_CODE_TTL_MS);

  /* Then */
  assert.strictEqual(justBefore.verdict, 'ok');
  assert.strictEqual(atExpiry.verdict, 'expired');
  assert.ok(isPairingOpen(state, T0 + PAIRING_CODE_TTL_MS - 1));
  assert.ok(!isPairingOpen(state, T0 + PAIRING_CODE_TTL_MS));
});

test('without a code shown, any attempt is not-pairing', () => {
  /* When */
  const result = attemptPairing(PAIRING_IDLE, '23456789', T0);

  /* Then */
  assert.strictEqual(result.verdict, 'not-pairing');
  assert.ok(!isPairingOpen(PAIRING_IDLE, T0));
});

test('a wrong code is wrong-code and leaves the right one working', () => {
  /* Given */
  const { state, code } = live();

  /* When */
  const wrong = attemptPairing(state, 'WRONGWRG', T0 + 10);
  const wrongLength = attemptPairing(wrong.state, code + 'X', T0 + 20);
  const right = attemptPairing(wrongLength.state, code, T0 + 30);

  /* Then */
  assert.strictEqual(wrong.verdict, 'wrong-code');
  assert.strictEqual(wrongLength.verdict, 'wrong-code');
  assert.strictEqual(right.verdict, 'ok');
});

test('the fifth wrong code locks pairing out, and the right code is refused during the lockout', () => {
  /* Given */
  const { state, code } = live();
  const fourWrong = wrongTimes(state, PAIRING_MAX_FAILURES - 1, T0 + 10);

  /* When */
  const fifth = attemptPairing(fourWrong, 'WRONGWRG', T0 + 20);
  const rightDuringLockout = attemptPairing(fifth.state, code, T0 + 20 + PAIRING_LOCKOUT_MS - 1);

  /* Then */
  assert.strictEqual(attemptPairing(fourWrong, code, T0 + 15).verdict, 'ok', 'four wrong codes do not lock out');
  assert.strictEqual(fifth.verdict, 'locked-out');
  assert.strictEqual(rightDuringLockout.verdict, 'locked-out');
  assert.ok(isPairingOpen(fifth.state, T0 + 30), 'the phone can still connect to be told it is locked out');
});

test('after the lockout the right code works again, if it has not expired', () => {
  /* Given */
  const { state, code } = live();
  const locked = wrongTimes(state, PAIRING_MAX_FAILURES, T0 + 10);

  /* When */
  const after = attemptPairing(locked, code, T0 + 10 + PAIRING_LOCKOUT_MS);

  /* Then */
  assert.strictEqual(after.verdict, 'ok');
});

test('after a lockout the count starts over', () => {
  /* Given */
  const { state, code } = live();
  const locked = wrongTimes(state, PAIRING_MAX_FAILURES, T0);
  const afterLockout = T0 + PAIRING_LOCKOUT_MS;

  /* When */
  const fourMore = wrongTimes(locked, PAIRING_MAX_FAILURES - 1, afterLockout);
  const fifthMore = attemptPairing(fourMore, 'WRONGWRG', afterLockout);

  /* Then */
  assert.strictEqual(attemptPairing(fourMore, code, afterLockout).verdict, 'ok');
  assert.strictEqual(fifthMore.verdict, 'locked-out');
});

test('an expired code is reported as expired even during a lockout', () => {
  /* Given */
  const { state } = live();
  const locked = wrongTimes(state, PAIRING_MAX_FAILURES, T0 + PAIRING_CODE_TTL_MS - 1000);

  /* When */
  const result = attemptPairing(locked, 'WRONGWRG', T0 + PAIRING_CODE_TTL_MS);

  /* Then */
  assert.strictEqual(result.verdict, 'expired');
});

test('showing a new code kills the old one and does not lift a running lockout', () => {
  /* Given */
  const first = live();
  const locked = wrongTimes(first.state, PAIRING_MAX_FAILURES, T0);

  /* When */
  const fresh = startPairing(locked, new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]), T0 + 1000);
  const freshCode = fresh.kind === 'live' ? fresh.code : '';
  const oldCode = attemptPairing(fresh, first.code, T0 + PAIRING_LOCKOUT_MS + 1);
  const duringLockout = attemptPairing(fresh, freshCode, T0 + 2000);
  const afterLockout = attemptPairing(fresh, freshCode, T0 + PAIRING_LOCKOUT_MS);

  /* Then */
  assert.strictEqual(oldCode.verdict, 'wrong-code');
  assert.strictEqual(duringLockout.verdict, 'locked-out');
  assert.strictEqual(afterLockout.verdict, 'ok');
});

test('a new code gets its own two minutes and a clean count', () => {
  /* Given */
  const { state } = live();
  const fourWrong = wrongTimes(state, PAIRING_MAX_FAILURES - 1, T0);

  /* When */
  const fresh = startPairing(fourWrong, BYTES, T0 + 60_000);
  const oneWrong = attemptPairing(fresh, 'WRONGWRG', T0 + 60_001);

  /* Then */
  assert.strictEqual(oneWrong.verdict, 'wrong-code');
  assert.ok(isPairingOpen(fresh, T0 + 60_000 + PAIRING_CODE_TTL_MS - 1));
});

test('stopping pairing closes it but keeps a running lockout', () => {
  /* Given */
  const { state } = live();
  const locked = wrongTimes(state, PAIRING_MAX_FAILURES, T0);

  /* When */
  const stopped = stopPairing(locked, T0 + 1000);
  const restarted = startPairing(stopped, BYTES, T0 + 2000);
  const code = restarted.kind === 'live' ? restarted.code : '';

  /* Then */
  assert.strictEqual(attemptPairing(stopped, code, T0 + 1000).verdict, 'not-pairing');
  assert.strictEqual(attemptPairing(restarted, code, T0 + 3000).verdict, 'locked-out');
  assert.strictEqual(attemptPairing(restarted, code, T0 + PAIRING_LOCKOUT_MS).verdict, 'ok');
});

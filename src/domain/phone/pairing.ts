/**
 * The one-time pairing code a phone proves it scanned the QR code with (#194).
 *
 * The code is the only thing standing between "a phone on the same Wi-Fi" and
 * "a phone that may ask the user to enrol it", so its rules are kept here,
 * pure, where they can be tested exhaustively: it is single use, it dies after
 * two minutes so a photo of the screen is useless later, and five wrong guesses
 * lock pairing out for a minute so the 40 bits of the code can't be walked.
 * The confirm dialog on the Mac is the second gate; this is the first.
 *
 * Time and randomness come in from the caller, so the service owns the clock
 * and the CSPRNG and this file owns only the decisions.
 */
import type { PairRejection } from './protocol';

/**
 * 32 symbols, so one random byte maps to one symbol with `& 31` and no bias.
 * No 0/O and no 1/I, the pairs a person reading the code off the screen would
 * mix up; the QR code carries it, but the Mac shows it too.
 */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export const PAIRING_CODE_LENGTH = 8;

export const PAIRING_CODE_TTL_MS = 2 * 60 * 1000;

/** Wrong codes in a row before pairing locks out. */
export const PAIRING_MAX_FAILURES = 5;

export const PAIRING_LOCKOUT_MS = 60 * 1000;

export type PairingState =
  | { kind: 'idle'; lockedUntil: number | null }
  | {
    kind: 'live';
    code: string;
    /** Epoch ms the code stops working. */
    expiresAt: number;
    /** Wrong codes since the last lockout (or since the code was made). */
    failures: number;
    /** Epoch ms a lockout ends; null when not locked out. */
    lockedUntil: number | null;
  };

export const PAIRING_IDLE: PairingState = { kind: 'idle', lockedUntil: null };

/** What a `pair` message gets; everything but `ok` is a `pair-rejected` reason. */
export type PairingVerdict = 'ok' | Exclude<PairRejection, 'declined'>;

/** A code from `PAIRING_CODE_LENGTH` random bytes; throws on fewer, which is a wiring bug. */
export function pairingCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < PAIRING_CODE_LENGTH) {
    throw new Error(`a pairing code needs ${PAIRING_CODE_LENGTH} random bytes, got ${bytes.length}`);
  }
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_CODE_ALPHABET[bytes[i] & 31];
  return code;
}

/** Whether `text` has the shape of a pairing code; for checking the QR code's text. */
export function isPairingCodeShape(text: string): boolean {
  if (text.length !== PAIRING_CODE_LENGTH) return false;
  for (const ch of text) if (!PAIRING_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * Show a new code. Any earlier code dies with it. A lockout still running
 * carries over: showing a fresh code must not be a way to reset the count
 * for whoever is guessing.
 */
export function startPairing(state: PairingState, randomBytes: Uint8Array, now: number): PairingState {
  return {
    kind: 'live',
    code: pairingCodeFromBytes(randomBytes),
    expiresAt: now + PAIRING_CODE_TTL_MS,
    failures: 0,
    lockedUntil: activeLockout(state, now),
  };
}

/** The user closed the pairing screen. A running lockout stays. */
export function stopPairing(state: PairingState, now: number): PairingState {
  return { kind: 'idle', lockedUntil: activeLockout(state, now) };
}

/**
 * Whether an unknown certificate may get a pairing connection right now. True
 * during a lockout too, so the phone can be told it is locked out rather than
 * being refused at the handshake with no reason.
 */
export function isPairingOpen(state: PairingState, now: number): boolean {
  return state.kind === 'live' && now < state.expiresAt;
}

/**
 * Check a code a phone sent.
 *
 * The order matters: an expired code is reported as expired whatever was
 * typed, and a lockout is checked before the code itself, so the right code
 * during a lockout is refused like any other. The fifth wrong code already
 * answers `locked-out`, since that is what the phone should tell its user next.
 * A right code consumes the pairing: the next attempt finds `not-pairing`.
 */
export function attemptPairing(state: PairingState, code: string, now: number): { state: PairingState; verdict: PairingVerdict } {
  if (state.kind !== 'live') return { state, verdict: 'not-pairing' };
  if (now >= state.expiresAt) return { state, verdict: 'expired' };
  if (activeLockout(state, now) !== null) return { state, verdict: 'locked-out' };

  if (sameCode(code, state.code)) {
    return { state: PAIRING_IDLE, verdict: 'ok' };
  }

  const failures = state.failures + 1;
  if (failures >= PAIRING_MAX_FAILURES) {
    return { state: { ...state, failures: 0, lockedUntil: now + PAIRING_LOCKOUT_MS }, verdict: 'locked-out' };
  }
  return { state: { ...state, failures, lockedUntil: null }, verdict: 'wrong-code' };
}

function activeLockout(state: PairingState, now: number): number | null {
  return state.lockedUntil !== null && now < state.lockedUntil ? state.lockedUntil : null;
}

/**
 * Compares every character whatever the first mismatch, so the time a wrong
 * code takes says nothing about how much of it was right.
 */
function sameCode(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

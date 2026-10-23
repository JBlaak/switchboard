/**
 * What the Phone access surfaces do: every call to main's Phone access, and
 * the answer dispatched.
 *
 * Each call answers the whole snapshot, which goes through the same event as
 * main's push; a call that fails is dispatched as a failure the settings
 * section shows in place. A call that never answers leaves things as they
 * were, which is `PHONE_ACCESS_OFF` until main has said anything.
 *
 * Revoke and Reset ask first, the way stopping a session does: they cannot be
 * undone, and a phone that is cut off has to pair again.
 */
import { dispatch } from '../../state/app-store';
import type { PhoneAccessState, PhoneDeviceView } from '../../../domain/phone/state';
import type { PhoneAccessCall } from '../../state/phone-access-slice';

/** Asks the user; `window.confirm` in the app, a stand-in in a test. */
export type Ask = (prompt: string) => boolean;

const ask: Ask = (prompt) => confirm(prompt);

/** Electron wraps a handler's error in "Error invoking remote method '…': Error: …"; the rest is the reason. */
export function callErrorMessage(err: unknown): string {
  const message = (err as Error)?.message || String(err ?? '');
  return message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

async function call(name: PhoneAccessCall, run: () => Promise<PhoneAccessState>): Promise<void> {
  try {
    const state = await run();
    if (state && typeof state === 'object') dispatch({ type: 'phoneAccessChanged', state });
  } catch (err) {
    dispatch({ type: 'phoneAccessCallFailed', call: name, message: callErrorMessage(err) });
  }
}

/**
 * Read the snapshot, at launch and whenever the settings open. Quiet when it
 * fails: there is nothing the user asked for to report on, and the section
 * shows Phone access as off.
 */
export async function loadPhoneAccess(): Promise<void> {
  try {
    const state = await window.api.getPhoneAccess();
    if (state && typeof state === 'object') dispatch({ type: 'phoneAccessChanged', state });
  } catch {
    // Main without Phone access, or not answering yet: it stays off.
  }
}

/** Which sessions a phone has, at launch. A failure leaves every terminal the Mac's. */
export async function loadTerminalOwners(): Promise<void> {
  try {
    const owners = await window.api.getTerminalOwners();
    if (owners && typeof owners === 'object') dispatch({ type: 'terminalOwnersLoaded', owners });
  } catch {
    // Every session is the Mac's.
  }
}

export function setPhoneAccessEnabled(enabled: boolean): Promise<void> {
  dispatch({ type: 'phoneAccessSwitched', enabled });
  return call(enabled ? 'enable' : 'disable', () => window.api.setPhoneAccessEnabled(enabled));
}

export function startPairing(): Promise<void> {
  return call('pair', () => window.api.startPhonePairing());
}

export function stopPairing(): Promise<void> {
  return call('stopPairing', () => window.api.stopPhonePairing());
}

/** Pair or Don't pair, on the confirm dialog. */
export function confirmPairing(requestId: string, accept: boolean): Promise<void> {
  dispatch({ type: 'phonePairingAnswered', requestId });
  return call('confirm', () => window.api.confirmPhonePairing(requestId, accept));
}

export async function revokeDevice(device: PhoneDeviceView, confirmed: Ask = ask): Promise<void> {
  if (!confirmed(`Revoke “${device.name}”? It is disconnected at once and has to pair again to come back.`)) return;
  await call('revoke', () => window.api.revokePhoneDevice(device.id));
}

export async function resetIdentity(confirmed: Ask = ask): Promise<void> {
  if (!confirmed('Reset this Mac\'s identity? This makes a new key and un-pairs every phone.')) return;
  await call('reset', () => window.api.resetPhoneIdentity());
}

/**
 * Use here: make the Mac the session's device again. Taken as done when main
 * says so, ahead of its push, so the terminal is back without waiting on it
 * (the push that follows changes nothing).
 */
export async function useTerminalHere(sessionId: string): Promise<void> {
  try {
    const result = await window.api.useTerminalHere(sessionId);
    if (result?.ok === false) {
      dispatch({ type: 'phoneAccessCallFailed', call: 'useHere', message: result.error ?? '' });
      return;
    }
    dispatch({ type: 'terminalOwnerChanged', sessionId, owner: { kind: 'mac' } });
  } catch (err) {
    dispatch({ type: 'phoneAccessCallFailed', call: 'useHere', message: callErrorMessage(err) });
  }
}

/** The id of the settings card, for the indicator to bring it into view. */
export const PHONE_ACCESS_SECTION_ID = 'sv-phone-access';

/**
 * Phone access as the renderer shows it (#194): main's snapshot, which device
 * each session's terminal is sized for, and the little the renderer adds of
 * its own — the switch's position while main thinks it over, and a call that
 * failed.
 *
 * The snapshot is main's, pushed whole on every change; an action's answer is
 * the same snapshot and goes through the same event. Until main says anything
 * it is `PHONE_ACCESS_OFF`, which is also what a renderer whose calls fail or
 * never answer keeps showing.
 *
 * Owners hold only the sessions a phone has: a session not listed is the
 * Mac's, so a dropped push or a session main never mentions defaults to the
 * terminal, not to the placeholder.
 *
 * The events are declared here rather than in `events.ts`, like the toolbar's;
 * `events.ts` folds them into the union. The two pushes are main's and live
 * there.
 */
import { PHONE_ACCESS_OFF } from '../../domain/phone/state';
import { movedEntry, withEntry, withoutEntry } from './records';
import type { PhoneAccessState, PhoneDeviceView, TerminalOwner } from '../../domain/phone/state';
import type { QuestionsSettled } from '../../domain/questions/question';
import type { IdRecord } from './records';
import type { QuestionsState } from './questions-slice';
import type { RendererEvent } from './events';

/** A session's owner when it is not the Mac. */
export type DeviceOwner = Extract<TerminalOwner, { kind: 'device' }>;

/** What the renderer asked main to do, for the copy of a call that failed. */
export type PhoneAccessCall =
  | 'load' | 'enable' | 'disable' | 'pair' | 'stopPairing' | 'confirm' | 'revoke' | 'reset' | 'useHere';

export type PhoneAccessEvent =
  /** The switch was flipped; its answer comes back as `phoneAccessChanged`. */
  | { type: 'phoneAccessSwitched'; enabled: boolean }
  /** Pair or Don't pair on the confirm dialog, which steps aside while main takes the answer. */
  | { type: 'phonePairingAnswered'; requestId: string }
  /** A call to main failed (rejected, or answered `ok: false`). */
  | { type: 'phoneAccessCallFailed'; call: PhoneAccessCall; message: string }
  /** `getTerminalOwners` answered: every session a phone has, at once. */
  | { type: 'terminalOwnersLoaded'; owners: Record<string, TerminalOwner> };

export interface PhoneAccessSliceState {
  /** Main's snapshot, or `PHONE_ACCESS_OFF` until it says otherwise. */
  readonly access: PhoneAccessState;
  /** sessionId → the phone its terminal is sized for. Absent: the Mac. */
  readonly owners: IdRecord<DeviceOwner>;
  /** Where the switch was flipped to, until main's answer says where it ended up. */
  readonly switchedTo: boolean | null;
  /** The last call that failed, shown in the section until main next answers. */
  readonly failure: { readonly call: PhoneAccessCall; readonly message: string } | null;
  /** The pairing request the user has answered, so its dialog goes even before main's snapshot does. */
  readonly answeredRequest: string | null;
}

export const initialPhoneAccessState: PhoneAccessSliceState = {
  access: PHONE_ACCESS_OFF,
  owners: {},
  switchedTo: null,
  failure: null,
  answeredRequest: null,
};

export function phoneAccessReducer(state: PhoneAccessSliceState, event: RendererEvent): PhoneAccessSliceState {
  switch (event.type) {
    case 'phoneAccessChanged':
      if (event.state === state.access && state.switchedTo === null && state.failure === null) return state;
      return { ...state, access: event.state, switchedTo: null, failure: null };

    case 'phonePairingAnswered':
      return state.answeredRequest === event.requestId ? state : { ...state, answeredRequest: event.requestId };

    case 'phoneAccessSwitched':
      return state.switchedTo === event.enabled ? state : { ...state, switchedTo: event.enabled };

    case 'phoneAccessCallFailed':
      // A failed switch goes back to where main last said it was, and a
      // pairing answer that did not land brings its dialog back.
      return {
        ...state,
        switchedTo: null,
        failure: { call: event.call, message: event.message },
        answeredRequest: event.call === 'confirm' ? null : state.answeredRequest,
      };

    case 'terminalOwnersLoaded': {
      const owners: Record<string, DeviceOwner> = {};
      for (const [sessionId, owner] of Object.entries(event.owners)) {
        if (owner.kind === 'device') owners[sessionId] = owner;
      }
      return { ...state, owners };
    }

    case 'terminalOwnerChanged': {
      const { sessionId, owner } = event;
      const held = state.owners[sessionId];
      // The same phone again changes nothing, so nothing re-renders.
      if (owner.kind === 'device' && held && held.deviceId === owner.deviceId && held.name === owner.name) return state;
      const owners = owner.kind === 'device' ? withEntry(state.owners, sessionId, owner) : withoutEntry(state.owners, sessionId);
      return owners === state.owners ? state : { ...state, owners };
    }

    default:
      return state;
  }
}

/** A re-keyed session stays on the device it was on. */
export function rekeyPhoneAccess(state: PhoneAccessSliceState, oldId: string, newId: string): PhoneAccessSliceState {
  const owners = movedEntry(state.owners, oldId, newId);
  return owners === state.owners ? state : { ...state, owners };
}

// ── What the surfaces read ──

/** The phone a session's terminal is sized for, or null when it is the Mac's. */
export function deviceOwnerIn(state: PhoneAccessSliceState, sessionId: string | null): DeviceOwner | null {
  return sessionId ? state.owners[sessionId] ?? null : null;
}

/** The pairing request to ask about, unless the user already answered it. */
export function confirmShownIn(state: PhoneAccessSliceState): PhoneAccessState['confirm'] {
  const { confirm } = state.access;
  return confirm && confirm.requestId !== state.answeredRequest ? confirm : null;
}

/** Where the switch shows: where it was flipped to while main answers, else main's setting. */
export function switchShownIn(state: PhoneAccessSliceState): boolean {
  return state.switchedTo ?? state.access.enabled;
}

/** The phones connected right now, in main's order. */
export function connectedDevices(access: PhoneAccessState): PhoneDeviceView[] {
  return access.devices.filter(device => device.connected);
}

/**
 * The toolbar indicator: absent while Phone access is off; "On" while it is on
 * with no phone attached; the phone's name (mint) while one is.
 */
export interface PhoneIndicator {
  readonly connected: boolean;
  readonly label: string;
  readonly title: string;
}

export function phoneIndicatorIn(access: PhoneAccessState): PhoneIndicator | null {
  if (!access.enabled) return null;
  const connected = connectedDevices(access);
  if (connected.length === 0) {
    return {
      connected: false,
      label: 'On',
      title: access.listening
        ? 'Phone access is on, no phone connected'
        : access.error ? `Phone access is on, but not listening: ${access.error}` : 'Phone access is starting',
    };
  }
  const more = connected.length > 1 ? ` +${connected.length - 1}` : '';
  return {
    connected: true,
    label: connected[0].name + more,
    title: `Phone access is on: ${connected.map(d => d.name).join(', ')} connected`,
  };
}

/**
 * Whether a settled set gets the "Answered on phone" note: answered from a
 * phone, and it was the set the session on screen was showing just before.
 */
export function answeredOnPhone(
  settled: QuestionsSettled, previous: QuestionsState, onScreen: string | null,
): boolean {
  if (settled.answeredOn !== 'phone' || !onScreen) return false;
  return previous.bySession[onScreen]?.toolUseId === settled.toolUseId;
}

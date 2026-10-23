/**
 * What the Phone access surfaces say, worked out from the snapshot and the
 * time: the listening line, a paired phone's dates, the pairing code's time
 * left, the terminal placeholder's lines and a failed call. Pure, so each is
 * tested in node; the components only lay them out.
 */
import { connectedDevices } from '../../state/phone-access-slice';
import type { PhoneAccessState, PhoneDeviceView } from '../../../domain/phone/state';
import type { DeviceOwner, PhoneAccessCall } from '../../state/phone-access-slice';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The line under the switch, or null while Phone access is off. */
export type ListeningLine =
  | { kind: 'listening'; host: string; connected: string | null }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string };

export function listeningLine(access: PhoneAccessState): ListeningLine | null {
  if (!access.enabled) return null;
  if (access.error) return { kind: 'failed', message: access.error };
  if (!access.listening) return { kind: 'starting' };
  const names = connectedDevices(access).map(device => device.name);
  return {
    kind: 'listening',
    host: access.host ?? 'this Mac',
    connected: names.length === 0 ? null : `${names.join(', ')} connected`,
  };
}

/** "1:42": how long the pairing code still works; null once it has run out. */
export function pairingTimeLeft(expiresAt: number, now: number): string | null {
  const seconds = Math.ceil((expiresAt - now) / 1000);
  if (seconds <= 0) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "23 Oct". */
export function shortDate(at: number): string {
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "just now", "12 minutes ago", "3 hours ago", "4 days ago", then the date. */
export function timeAgo(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return 'just now';
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (diff < HOUR) return plural(Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return plural(Math.floor(diff / HOUR), 'hour');
  if (diff < 14 * DAY) return plural(Math.floor(diff / DAY), 'day');
  return `on ${shortDate(at)}`;
}

/** A paired phone's second line: when it was paired, and when it was last seen. */
export function deviceLine(device: PhoneDeviceView, now: number): { paired: string; seen: string; connected: boolean } {
  const paired = `Paired ${shortDate(device.pairedAt)}`;
  if (device.connected) return { paired, seen: 'Connected now', connected: true };
  if (device.lastSeenAt === null) return { paired, seen: 'Never connected', connected: false };
  return { paired, seen: `Last seen ${timeAgo(device.lastSeenAt, now)}`, connected: false };
}

/** What the terminal panel says in place of a session a phone has. */
export function placeholderCopy(
  owner: DeviceOwner, access: PhoneAccessState, now: number,
): { title: string; body: string; note: string | null } {
  const device = access.devices.find(d => d.id === owner.deviceId);
  const note = device && !device.connected && device.lastSeenAt !== null
    ? `${owner.name} disconnected ${timeAgo(device.lastSeenAt, now)}. The session stays sized for it until you take it back.`
    : null;
  return {
    title: `Active on ${owner.name}`,
    body: 'The terminal is sized for your phone right now. Use it here to resize it back to this window.',
    note,
  };
}

const FAILED: Record<PhoneAccessCall, string> = {
  load: 'Couldn\'t read Phone access',
  enable: 'Couldn\'t turn Phone access on',
  disable: 'Couldn\'t turn Phone access off',
  pair: 'Couldn\'t start pairing',
  stopPairing: 'Couldn\'t stop pairing',
  confirm: 'Couldn\'t answer the pairing',
  revoke: 'Couldn\'t revoke the phone',
  reset: 'Couldn\'t reset this Mac\'s identity',
  useHere: 'Couldn\'t take the session back',
};

export function failureLine(failure: { call: PhoneAccessCall; message: string }): string {
  return failure.message ? `${FAILED[failure.call]}: ${failure.message}` : FAILED[failure.call];
}

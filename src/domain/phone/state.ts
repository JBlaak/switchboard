/**
 * Phone access as the Mac's renderer sees it (#194): the settings section, the
 * toolbar indicator and the pairing dialog all read this one snapshot, pushed
 * whole on every change.
 */
import type { TerminalOwner } from './protocol';

export type { TerminalOwner } from './protocol';

export interface PhoneDeviceView {
  id: string;
  name: string;
  /** Epoch ms. */
  pairedAt: number;
  /** Epoch ms; null if it never connected after pairing. */
  lastSeenAt: number | null;
  connected: boolean;
}

export interface PhoneAccessState {
  /** The setting: Phone access on or off. */
  enabled: boolean;
  /** The listener is up. False while starting, and when it failed to start (see `error`). */
  listening: boolean;
  /** Why the listener isn't up although enabled; null otherwise. */
  error: string | null;
  /** The Bonjour host name, e.g. "joris-mbp.local"; null while not listening. */
  host: string | null;
  port: number | null;
  devices: PhoneDeviceView[];
  /** A live pairing code: the QR code's text and when it stops working (epoch ms). */
  pairing: { invite: string; expiresAt: number } | null;
  /** A phone sent the right code and waits for the user to confirm it on the Mac. */
  confirm: { requestId: string; deviceName: string } | null;
}

export const PHONE_ACCESS_OFF: PhoneAccessState = {
  enabled: false,
  listening: false,
  error: null,
  host: null,
  port: null,
  devices: [],
  pairing: null,
  confirm: null,
};

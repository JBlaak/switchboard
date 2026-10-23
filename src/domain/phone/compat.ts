/**
 * What a phone's `hello` gets back (#194).
 *
 * The app and the desktop ship from one repo but are installed separately, so
 * an old APK meeting a newer Switchboard is normal. Rather than guess at what
 * an older peer can read, the versions must match exactly; anything else gets
 * `update-required` and a close the app turns into its "Update the app" screen.
 * The version check comes before pairing, so a mismatched app is never asked
 * for a code it might send in a shape the Mac misreads.
 */
import { CLOSE, PROTOCOL_VERSION, type ServerMessage } from './protocol';

/** What the listener decided the connection may do; mirrors the port's ConnectionGrant. */
export type HelloGrant = { kind: 'device'; deviceId: string } | { kind: 'pairing' };

export interface HelloReply {
  message: ServerMessage;
  /** Close with this code after sending `message`; null keeps the connection open. */
  close: number | null;
}

export function isCompatibleProtocol(peer: number, ours: number = PROTOCOL_VERSION): boolean {
  return peer === ours;
}

export function helloReply(
  peerProtocol: number,
  grant: HelloGrant,
  mac: { name: string; version: string },
  ours: number = PROTOCOL_VERSION,
): HelloReply {
  if (!isCompatibleProtocol(peerProtocol, ours)) {
    return { message: { type: 'update-required', protocol: ours, macVersion: mac.version }, close: CLOSE.updateRequired };
  }
  if (grant.kind === 'pairing') {
    return { message: { type: 'pairing', protocol: ours, macName: mac.name }, close: null };
  }
  return { message: { type: 'welcome', protocol: ours, macName: mac.name, deviceId: grant.deviceId }, close: null };
}

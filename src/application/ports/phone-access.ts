/**
 * The edges of Phone access (#194): the TLS listener the phones connect to,
 * the Mac's own identity, the enrolled devices, and the Bonjour advertisement.
 *
 * The phone access services are written against these and never see a socket,
 * a certificate file or a database row; that is what lets the whole pairing
 * and session flow be tested with fakes in node.
 */
import type { ClientMessage, ServerMessage } from '../../domain/phone/protocol';

// ── The Mac's identity ──

/** The Mac's TLS key and self-signed certificate, PEM encoded. */
export interface ServerIdentity {
  keyPem: string;
  certPem: string;
  /** Lowercase hex SHA-256 of the certificate's DER, no separators; what the QR code carries. */
  fingerprint: string;
}

/**
 * Where the Mac's identity is kept: the key encrypted with Electron safeStorage
 * in the app's user data. `load` makes one the first time.
 */
export interface ServerIdentityStore {
  load(): Promise<ServerIdentity>;
  /** Throws the old identity away and makes a new one, which un-pairs every phone. */
  reset(): Promise<ServerIdentity>;
}

// ── Enrolled devices ──

export interface EnrolledDevice {
  id: string;
  /** What the phone called itself, e.g. "Pixel 9 Pro". */
  name: string;
  /** Lowercase hex SHA-256 of the phone's certificate, no separators. */
  fingerprint: string;
  /** Epoch ms. */
  pairedAt: number;
  /** Epoch ms of the last connection, null if it never connected after pairing. */
  lastSeenAt: number | null;
}

/** The enrolled phones, kept in SQLite. */
export interface DeviceRegistry {
  list(): EnrolledDevice[];
  findByFingerprint(fingerprint: string): EnrolledDevice | null;
  add(device: EnrolledDevice): void;
  remove(id: string): void;
  touch(id: string, at: number): void;
  /** Every device; used by Reset. */
  clear(): void;
}

// ── The listener ──

/**
 * What a TLS client may do, decided from its certificate before any WebSocket
 * traffic: an enrolled device gets a full connection, an unknown certificate
 * gets a pairing connection only while a code is live, everything else is
 * refused during the handshake.
 */
export type ConnectionGrant =
  | { kind: 'device'; deviceId: string }
  | { kind: 'pairing' }
  | null;

/** One phone's open WebSocket, as the services see it. */
export interface DeviceConnection {
  /** Unique per connection, not per device. */
  readonly id: string;
  /** The client certificate's fingerprint. */
  readonly fingerprint: string;
  readonly grant: Exclude<ConnectionGrant, null>;
  send(message: ServerMessage): void;
  /** Terminal output, sent as a binary frame (see protocol.ts). */
  sendTerminal(sessionId: string, data: string): void;
  close(code: number, reason: string): void;
}

export interface DeviceLinkHandlers {
  /** Asked once per TLS handshake. */
  authorize(fingerprint: string): ConnectionGrant;
  connected(connection: DeviceConnection): void;
  /** A text frame that parsed as a ClientMessage. Malformed frames close the connection with CLOSE.protocolError and never get here. */
  message(connection: DeviceConnection, message: ClientMessage): void;
  disconnected(connection: DeviceConnection): void;
}

/** The TLS 1.3 + WebSocket listener on the Mac's LAN interfaces. */
export interface DeviceLink {
  /** Starts listening; resolves with the port. Port 0 picks one. */
  start(identity: ServerIdentity, port: number, handlers: DeviceLinkHandlers): Promise<number>;
  /** Closes every connection with `code` and stops listening. */
  stop(code: number, reason: string): Promise<void>;
  readonly listening: boolean;
}

// ── Discovery ──

/** The Bonjour advertisement of `_switchboard._tcp`. */
export interface ServiceAdvertiser {
  advertise(name: string, port: number, txt: Record<string, string>): void;
  withdraw(): void;
  /** The host name phones resolve, e.g. "joris-mbp.local". */
  hostName(): string;
}

/**
 * Phone access on the Mac (#194): the listener's lifecycle, pairing, and the
 * enrolled devices.
 *
 * This service decides who is on the other end of a connection and what they
 * may do; it never looks at what an enrolled phone does after `welcome`. That
 * goes to the sessions handler, which owns the session list, terminals,
 * ownership and questions. Here a connection gets exactly one `hello`, and a
 * pairing connection may send nothing but `hello` and one `pair`.
 *
 * Everything the renderer shows comes from one snapshot, `state()`, pushed
 * whole on every change (the code expiring included), and every call the IPC
 * makes answers with that same snapshot.
 *
 * Lifecycle calls are async (the identity, the listener) and run one after
 * another, so a quick on-off-on in Settings ends in the state of the last
 * click rather than in whichever finished last.
 */
import { CLOSE, PROTOCOL_VERSION } from '../../domain/phone/protocol';
import type { ClientMessage } from '../../domain/phone/protocol';
import { encodeInvite } from '../../domain/phone/codec';
import { helloReply } from '../../domain/phone/compat';
import {
  PAIRING_CODE_LENGTH, PAIRING_IDLE, attemptPairing, isPairingOpen, startPairing, stopPairing,
} from '../../domain/phone/pairing';
import type { PairingState } from '../../domain/phone/pairing';
import type { PhoneAccessState } from '../../domain/phone/state';
import type { Clock, TimerHandle, Timers } from '../ports/clock';
import type { IdGenerator } from '../ports/ids';
import type { Logger } from '../ports/logger';
import type {
  ConnectionGrant, DeviceConnection, DeviceLink, DeviceLinkHandlers, DeviceRegistry,
  ServerIdentity, ServerIdentityStore, ServiceAdvertiser,
} from '../ports/phone-access';
import type { RendererGateway } from '../ports/renderer-gateway';
import type { SettingsStore } from '../ports/settings-store';

/** The settings key that keeps Phone access on across restarts. */
export const PHONE_ACCESS_ENABLED_KEY = 'phoneAccessEnabled';

/** WebSocket's "going away": the Mac is quitting or the listener restarts; the app reconnects. */
const GOING_AWAY = 1001;

/** What a device is called when its `pair` message names it with nothing but spaces. */
const UNNAMED_DEVICE = 'Phone';

/**
 * Where enrolled connections go after `welcome`: the sessions service (#203).
 * Satisfied structurally, so neither service imports the other.
 */
export interface PhoneSessionsHandler {
  connected(connection: DeviceConnection, device: { id: string; name: string }): void;
  message(connection: DeviceConnection, message: ClientMessage): void;
  disconnected(connection: DeviceConnection): void;
  /** A device was revoked or the identity reset: give its sessions back to the Mac. */
  deviceRemoved(deviceId: string): void;
}

export interface PhoneAccessServiceDeps {
  link: DeviceLink;
  identity: ServerIdentityStore;
  devices: DeviceRegistry;
  advertiser: ServiceAdvertiser;
  settings: Pick<SettingsStore, 'get' | 'set'>;
  renderer: Pick<RendererGateway, 'phoneAccessChanged'>;
  sessions: PhoneSessionsHandler;
  clock: Clock;
  timers: Timers;
  /** Device ids and confirm request ids. */
  ids: IdGenerator;
  /** Cryptographically random bytes, for pairing codes. */
  randomBytes(length: number): Uint8Array;
  /** What phones call this Mac: the Bonjour name and `welcome`'s `macName`. */
  macName: string;
  /** Switchboard's version, for `update-required`. */
  appVersion: string;
  /** The port to listen on; 0 (the default) lets the OS pick, Bonjour tells the phones. */
  port?: number;
  log: Logger;
}

/** One open connection, as this service tracks it. */
interface Link {
  readonly connection: DeviceConnection;
  /** `hello` answered and the connection kept. */
  greeted: boolean;
  /** A pairing connection already sent its `pair`. */
  paired: boolean;
}

/** A phone that sent the right code, waiting on the Mac's confirm dialog. */
interface PendingConfirm {
  readonly requestId: string;
  readonly deviceName: string;
  readonly connectionId: string;
}

export class PhoneAccessService {
  readonly #links = new Map<string, Link>();
  #listening = false;
  #error: string | null = null;
  #host: string | null = null;
  #port: number | null = null;
  #identity: ServerIdentity | null = null;
  #pairing: PairingState = PAIRING_IDLE;
  #invite: string | null = null;
  #expiry: TimerHandle | null = null;
  #confirm: PendingConfirm | null = null;
  /** The tail of the lifecycle queue. */
  #queue: Promise<unknown> = Promise.resolve();

  readonly #handlers: DeviceLinkHandlers = {
    authorize: (fingerprint) => this.#authorize(fingerprint),
    connected: (connection) => this.#connected(connection),
    message: (connection, message) => this.#message(connection, message),
    disconnected: (connection) => this.#disconnected(connection),
  };

  constructor(private readonly deps: PhoneAccessServiceDeps) {}

  // ── Lifecycle ──

  /** At boot: bring the listener up if Phone access was left on. */
  start(): Promise<PhoneAccessState> {
    return this.#serial(async () => {
      if (this.#enabled()) await this.#bringUp();
    });
  }

  /** At quit: close every connection and stop advertising. The setting stays. */
  shutdown(): Promise<void> {
    return this.#serial(() => this.#bringDown(GOING_AWAY, 'Switchboard is quitting')).then(() => undefined);
  }

  /**
   * The listener binds the LAN addresses it finds at start, so when the Mac's
   * network changes it has to start again to follow. Phones see "going away"
   * and reconnect. A no-op while Phone access is off.
   */
  restart(): Promise<PhoneAccessState> {
    return this.#serial(async () => {
      if (!this.#enabled()) return;
      await this.#bringDown(GOING_AWAY, 'The Mac changed networks');
      await this.#bringUp();
    });
  }

  /**
   * The toggle in Settings. On also retries a listener that failed to start;
   * off closes every connection with `turnedOff`.
   */
  setEnabled(enabled: boolean): Promise<PhoneAccessState> {
    return this.#serial(async () => {
      this.deps.settings.set(PHONE_ACCESS_ENABLED_KEY, enabled);
      if (enabled && !this.#listening) await this.#bringUp();
      else if (!enabled) await this.#bringDown(CLOSE.turnedOff, 'Phone access was turned off');
      else this.#changed();
    });
  }

  // ── Pairing ──

  /** Show a fresh code; any earlier one dies. Only while listening: the invite needs the port. */
  startPairing(): PhoneAccessState {
    const { clock, timers, randomBytes, advertiser } = this.deps;
    if (!this.#listening || !this.#identity || this.#port === null) return this.state();

    const now = clock.now();
    this.#pairing = startPairing(this.#pairing, randomBytes(PAIRING_CODE_LENGTH), now);
    if (this.#pairing.kind !== 'live') return this.state();
    this.#invite = encodeInvite({
      protocol: PROTOCOL_VERSION,
      fingerprint: this.#identity.fingerprint,
      code: this.#pairing.code,
      host: this.#host ?? advertiser.hostName(),
      port: this.#port,
    });
    timers.clearTimeout(this.#expiry);
    this.#expiry = timers.setTimeout(() => {
      this.#expiry = null;
      this.#endPairing();
      this.#changed();
    }, this.#pairing.expiresAt - now);
    this.#changed();
    return this.state();
  }

  /** The user closed the pairing screen. A confirm already showing stays. */
  stopPairing(): PhoneAccessState {
    this.#endPairing();
    this.#changed();
    return this.state();
  }

  /**
   * The user answered the confirm dialog. Accepting enrols the certificate the
   * pairing connection presented, so the enrolment is bound to the key that
   * ran the pairing; either way the phone hears the outcome and is closed, to
   * reconnect as paired or not. `confirm` is cleared whatever happens.
   */
  confirmPairing(requestId: string, accept: boolean): PhoneAccessState {
    const { devices, ids, clock, log } = this.deps;
    const confirm = this.#confirm;
    if (!confirm || confirm.requestId !== requestId) return this.state();
    this.#confirm = null;

    const link = this.#links.get(confirm.connectionId);
    if (link) {
      const { connection } = link;
      if (accept) {
        const id = ids.newId();
        devices.add({ id, name: confirm.deviceName, fingerprint: connection.fingerprint, pairedAt: clock.now(), lastSeenAt: null });
        log.info(`[phone] paired ${confirm.deviceName} as ${id}`);
        connection.send({ type: 'pair-accepted', deviceId: id });
        connection.close(CLOSE.pairingOver, 'Paired');
      } else {
        connection.send({ type: 'pair-rejected', reason: 'declined' });
        connection.close(CLOSE.pairingOver, 'Pairing declined');
      }
    }
    this.#changed();
    return this.state();
  }

  // ── Devices ──

  /** Un-pair one phone; its live connections are told and closed at once. */
  revoke(deviceId: string): PhoneAccessState {
    this.deps.devices.remove(deviceId);
    for (const link of [...this.#links.values()]) {
      const { grant } = link.connection;
      if (grant.kind === 'device' && grant.deviceId === deviceId) this.#sendRevoked(link.connection);
    }
    this.deps.sessions.deviceRemoved(deviceId);
    this.#changed();
    return this.state();
  }

  /**
   * A new Mac identity, which un-pairs every phone: their pinned fingerprint
   * no longer matches. Also the way out when the stored key can't be read.
   * The listener, if on, starts again with the new certificate.
   */
  reset(): Promise<PhoneAccessState> {
    return this.#serial(async () => {
      const { devices, identity, sessions, log } = this.deps;
      const removed = devices.list().map((device) => device.id);
      for (const link of [...this.#links.values()]) {
        if (link.connection.grant.kind === 'device') this.#sendRevoked(link.connection);
      }
      devices.clear();
      for (const id of removed) sessions.deviceRemoved(id);

      await this.#bringDown(CLOSE.notPaired, 'Phone access was reset');
      let fresh: ServerIdentity;
      try {
        fresh = await identity.reset();
      } catch (err) {
        log.error('[phone] reset failed:', (err as Error).message);
        this.#error = `Could not make a new identity: ${(err as Error).message}`;
        this.#changed();
        return;
      }
      this.#error = null;
      if (this.#enabled()) await this.#bringUp(fresh);
      else this.#changed();
    });
  }

  // ── The snapshot ──

  state(): PhoneAccessState {
    const connected = new Set<string>();
    for (const { connection } of this.#links.values()) {
      if (connection.grant.kind === 'device') connected.add(connection.grant.deviceId);
    }
    return {
      enabled: this.#enabled(),
      listening: this.#listening,
      error: this.#error,
      host: this.#listening ? this.#host : null,
      port: this.#listening ? this.#port : null,
      devices: this.deps.devices.list().map((device) => ({
        id: device.id,
        name: device.name,
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt,
        connected: connected.has(device.id),
      })),
      pairing: this.#pairing.kind === 'live' && this.#invite
        ? { invite: this.#invite, expiresAt: this.#pairing.expiresAt }
        : null,
      confirm: this.#confirm ? { requestId: this.#confirm.requestId, deviceName: this.#confirm.deviceName } : null,
    };
  }

  // ── The listener's handlers ──

  #authorize(fingerprint: string): ConnectionGrant {
    const device = this.deps.devices.findByFingerprint(fingerprint);
    if (device) return { kind: 'device', deviceId: device.id };
    if (isPairingOpen(this.#pairing, this.deps.clock.now())) return { kind: 'pairing' };
    return null;
  }

  #connected(connection: DeviceConnection): void {
    this.#links.set(connection.id, { connection, greeted: false, paired: false });
    if (connection.grant.kind === 'device') {
      this.deps.devices.touch(connection.grant.deviceId, this.deps.clock.now());
      this.#changed();
    }
  }

  #message(connection: DeviceConnection, message: ClientMessage): void {
    const link = this.#links.get(connection.id);
    if (!link) return;

    if (!link.greeted) {
      if (message.type !== 'hello') return this.#protocolError(connection, 'Expected hello');
      this.#hello(link, message.protocol);
      return;
    }
    if (connection.grant.kind === 'device') {
      if (message.type === 'hello') return this.#protocolError(connection, 'Hello was already answered');
      this.deps.sessions.message(connection, message);
      return;
    }
    if (message.type !== 'pair' || link.paired) return this.#protocolError(connection, 'A pairing connection may only pair');
    link.paired = true;
    this.#pair(connection, message.code, message.deviceName);
  }

  #disconnected(connection: DeviceConnection): void {
    const link = this.#links.get(connection.id);
    if (!link || link.connection !== connection) return;
    this.#links.delete(connection.id);
    if (link.greeted && connection.grant.kind === 'device') this.deps.sessions.disconnected(connection);
    if (this.#confirm?.connectionId === connection.id) this.#confirm = null;
    this.#changed();
  }

  // ── Hello and pair ──

  #hello(link: Link, protocol: number): void {
    const { connection } = link;
    const { macName, appVersion, devices, sessions } = this.deps;
    const reply = helloReply(protocol, connection.grant, { name: macName, version: appVersion });
    connection.send(reply.message);
    if (reply.close !== null) {
      connection.close(reply.close, 'Update required');
      return;
    }
    link.greeted = true;
    if (connection.grant.kind === 'device') {
      const { deviceId } = connection.grant;
      const device = devices.list().find((d) => d.id === deviceId);
      sessions.connected(connection, { id: deviceId, name: device?.name ?? UNNAMED_DEVICE });
    }
  }

  /**
   * A right code consumes the pairing (no second phone can use it) and puts
   * the confirm dialog up; every rejection ends the connection, since the
   * phone has nothing else to try with the code it scanned.
   */
  #pair(connection: DeviceConnection, code: string, deviceName: string): void {
    const { clock, ids, timers } = this.deps;
    const { state, verdict } = attemptPairing(this.#pairing, code, clock.now());
    this.#pairing = state;
    if (verdict !== 'ok') {
      connection.send({ type: 'pair-rejected', reason: verdict });
      connection.close(CLOSE.pairingOver, `Pairing rejected: ${verdict}`);
      return;
    }
    timers.clearTimeout(this.#expiry);
    this.#expiry = null;
    this.#invite = null;
    this.#confirm = { requestId: ids.newId(), deviceName: deviceName.trim() || UNNAMED_DEVICE, connectionId: connection.id };
    connection.send({ type: 'pair-pending' });
    this.#changed();
  }

  // ── Internals ──

  #enabled(): boolean {
    return this.deps.settings.get<boolean>(PHONE_ACCESS_ENABLED_KEY) === true;
  }

  /** Load the identity (unless handed a fresh one), listen, advertise. Failures land in `error`. */
  async #bringUp(identity?: ServerIdentity): Promise<void> {
    const { link, advertiser, log } = this.deps;
    this.#error = null;
    this.#changed();

    try {
      this.#identity = identity ?? await this.deps.identity.load();
    } catch (err) {
      log.error('[phone] identity failed to load:', (err as Error).message);
      this.#error = `The Mac's Phone access key could not be read (${(err as Error).message}). Reset Phone access to make a new one; every phone will need pairing again.`;
      this.#changed();
      return;
    }

    try {
      this.#port = await link.start(this.#identity, this.deps.port ?? 0, this.#handlers);
    } catch (err) {
      log.error('[phone] listener failed to start:', (err as Error).message);
      this.#error = `Could not start listening: ${(err as Error).message}`;
      this.#port = null;
      this.#changed();
      return;
    }
    this.#host = advertiser.hostName();
    this.#listening = true;
    advertiser.advertise(this.deps.macName, this.#port, { v: String(PROTOCOL_VERSION) });
    this.#changed();
  }

  /** Stop listening with `code` on every connection, withdraw the advertisement, drop any pairing. */
  async #bringDown(code: number, reason: string): Promise<void> {
    const { link, advertiser, log } = this.deps;
    this.#endPairing();
    this.#confirm = null;
    if (this.#listening || link.listening) {
      try {
        await link.stop(code, reason);
      } catch (err) {
        log.warn('[phone] listener failed to stop cleanly:', (err as Error).message);
      }
      advertiser.withdraw();
    }
    // The link reports closes as they happen; whatever it hasn't yet is gone all the same.
    for (const { connection } of [...this.#links.values()]) this.#disconnected(connection);
    this.#listening = false;
    this.#host = null;
    this.#port = null;
    if (!this.#enabled()) this.#error = null;
    this.#changed();
  }

  #endPairing(): void {
    this.deps.timers.clearTimeout(this.#expiry);
    this.#expiry = null;
    this.#pairing = stopPairing(this.#pairing, this.deps.clock.now());
    this.#invite = null;
  }

  #sendRevoked(connection: DeviceConnection): void {
    connection.send({ type: 'revoked' });
    connection.close(CLOSE.notPaired, 'No longer paired');
  }

  #protocolError(connection: DeviceConnection, reason: string): void {
    this.deps.log.warn(`[phone] connection ${connection.id}: ${reason}`);
    connection.close(CLOSE.protocolError, reason);
  }

  #changed(): void {
    this.deps.renderer.phoneAccessChanged(this.state());
  }

  /** Run `step` after every earlier lifecycle call, and answer the snapshot after it. */
  #serial(step: () => Promise<void>): Promise<PhoneAccessState> {
    const run = this.#queue.then(step);
    this.#queue = run.catch(() => undefined);
    return run.then(() => this.state());
  }
}

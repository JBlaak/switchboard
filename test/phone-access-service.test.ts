import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHONE_ACCESS_ENABLED_KEY, PhoneAccessService, type PhoneSessionsHandler,
} from '../src/application/services/phone-access-service';
import { CLOSE, PROTOCOL_VERSION } from '../src/domain/phone/protocol';
import type { ClientMessage, ServerMessage } from '../src/domain/phone/protocol';
import { parseInvite } from '../src/domain/phone/codec';
import { PAIRING_CODE_TTL_MS, PAIRING_MAX_FAILURES } from '../src/domain/phone/pairing';
import type { PhoneAccessState } from '../src/domain/phone/state';
import type {
  ConnectionGrant, DeviceConnection, DeviceLink, DeviceLinkHandlers, DeviceRegistry,
  EnrolledDevice, ServerIdentity, ServerIdentityStore, ServiceAdvertiser,
} from '../src/application/ports/phone-access';
import { fakeRenderer, fakeTimers, silentLog } from './support/fakes';

/**
 * Who gets in and what they may do: the listener follows the setting, a phone
 * pairs only with a live code and the user's confirm, a pairing connection
 * can do nothing else, and revoke and reset cut phones off at once. Driven
 * through a fake listener the way the TLS one would call the handlers.
 */

const IDENTITY: ServerIdentity = { keyPem: 'key', certPem: 'cert', fingerprint: 'a'.repeat(64) };
const PHONE_FP = 'b'.repeat(64);

/** A connection that records what it was sent and how it was closed. */
interface FakeConnection extends DeviceConnection {
  readonly sent: ServerMessage[];
  closed: { code: number; reason: string } | null;
}

/** The listener: records start/stop, and lets a test connect phones through the real handlers. */
function fakeLink() {
  let handlers: DeviceLinkHandlers | null = null;
  let seq = 0;
  const live = new Set<FakeConnection>();
  const link = {
    listening: false,
    starts: [] as { identity: ServerIdentity; port: number }[],
    stops: [] as number[],
    failStart: null as Error | null,
    async start(identity: ServerIdentity, port: number, h: DeviceLinkHandlers) {
      if (link.failStart) throw link.failStart;
      handlers = h;
      link.listening = true;
      link.starts.push({ identity, port });
      return 52000;
    },
    async stop(code: number, reason: string) {
      link.listening = false;
      link.stops.push(code);
      for (const connection of [...live]) connection.close(code, reason);
    },
    /** A TLS handshake with `fingerprint`; null when the listener refused it. */
    connect(fingerprint: string): FakeConnection | null {
      const grant: ConnectionGrant = handlers!.authorize(fingerprint);
      if (!grant) return null;
      const connection: FakeConnection = {
        id: `conn-${++seq}`,
        fingerprint,
        grant,
        sent: [],
        closed: null,
        send(message) { connection.sent.push(message); },
        sendTerminal() {},
        close(code, reason) {
          if (connection.closed) return;
          connection.closed = { code, reason };
          live.delete(connection);
          handlers!.disconnected(connection);
        },
      };
      live.add(connection);
      handlers!.connected(connection);
      return connection;
    },
    send(connection: FakeConnection, message: ClientMessage) {
      handlers!.message(connection, message);
    },
  };
  return link satisfies DeviceLink;
}

function fakeIdentityStore() {
  let current = IDENTITY;
  let generation = 0;
  const store = {
    failLoad: null as Error | null,
    async load() {
      if (store.failLoad) throw store.failLoad;
      return current;
    },
    async reset() {
      current = { keyPem: 'key2', certPem: 'cert2', fingerprint: String(++generation).repeat(64) };
      return current;
    },
  };
  return store satisfies ServerIdentityStore;
}

function fakeRegistry(initial: EnrolledDevice[] = []) {
  const rows = new Map(initial.map((d) => [d.id, { ...d }]));
  return {
    list: () => [...rows.values()],
    findByFingerprint: (fp: string) => [...rows.values()].find((d) => d.fingerprint === fp) ?? null,
    add: (device: EnrolledDevice) => { rows.set(device.id, { ...device }); },
    remove: (id: string) => { rows.delete(id); },
    touch: (id: string, at: number) => { const d = rows.get(id); if (d) d.lastSeenAt = at; },
    clear: () => { rows.clear(); },
  } satisfies DeviceRegistry;
}

function fakeAdvertiser() {
  const advertiser = {
    advertised: [] as { name: string; port: number; txt: Record<string, string> }[],
    withdrawn: 0,
    advertise(name: string, port: number, txt: Record<string, string>) { advertiser.advertised.push({ name, port, txt }); },
    withdraw() { advertiser.withdrawn++; },
    hostName: () => 'joris-mbp.local',
  };
  return advertiser satisfies ServiceAdvertiser;
}

/** The sessions service's side of the hand-off, recorded. */
function fakeSessions() {
  const events: [string, ...unknown[]][] = [];
  const handler: PhoneSessionsHandler = {
    connected: (connection, device) => { events.push(['connected', connection.id, device]); },
    message: (connection, message) => { events.push(['message', connection.id, message]); },
    disconnected: (connection) => { events.push(['disconnected', connection.id]); },
    deviceRemoved: (deviceId) => { events.push(['deviceRemoved', deviceId]); },
  };
  return { handler, events };
}

const PIXEL: EnrolledDevice = { id: 'dev-pixel', name: 'Pixel 9', fingerprint: 'c'.repeat(64), pairedAt: 10, lastSeenAt: null };

function harness(opts: { enabled?: boolean; devices?: EnrolledDevice[] } = {}) {
  const link = fakeLink();
  const identity = fakeIdentityStore();
  const devices = fakeRegistry(opts.devices ?? []);
  const advertiser = fakeAdvertiser();
  const renderer = fakeRenderer();
  const sessions = fakeSessions();
  const timers = fakeTimers();
  const store = new Map<string, unknown>();
  if (opts.enabled) store.set(PHONE_ACCESS_ENABLED_KEY, true);
  let now = 1_000;
  let id = 0;
  const service = new PhoneAccessService({
    link, identity, devices, advertiser, renderer, timers,
    sessions: sessions.handler,
    settings: { get: <T>(key: string) => (store.get(key) as T) ?? null, set: (key, value) => { store.set(key, value); } },
    clock: { now: () => now },
    ids: { newId: () => `id-${++id}` },
    randomBytes: (n) => new Uint8Array(n).fill(2),
    macName: 'Joris MacBook',
    appVersion: '2.9.0',
    log: silentLog,
  });
  const pushes = () => renderer.only('phoneAccessChanged').map((e) => e[1] as PhoneAccessState);
  return {
    service, link, identity, devices, advertiser, renderer, sessions, timers, store, pushes,
    lastPush: () => pushes().at(-1)!,
    setNow: (t: number) => { now = t; },
  };
}

/** The code `randomBytes` filled with 2s makes: the alphabet's 3rd symbol eight times. */
const CODE = '44444444';

/** Listening, with a pairing code showing and a phone connected and greeted on it. */
async function pairingPhone() {
  const h = harness({ enabled: true });
  await h.service.start();
  h.service.startPairing();
  const phone = h.link.connect(PHONE_FP)!;
  h.link.send(phone, { type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });
  return { ...h, phone };
}

// ── Lifecycle ──

test('start leaves the listener down while Phone access is off', async () => {
  /* Given */
  const h = harness();

  /* When */
  const state = await h.service.start();

  /* Then */
  assert.equal(h.link.starts.length, 0);
  assert.equal(h.advertiser.advertised.length, 0);
  assert.equal(state.enabled, false);
  assert.equal(state.listening, false);
});

test('start brings the listener up and advertises it when the setting was left on', async () => {
  /* Given */
  const h = harness({ enabled: true });

  /* When */
  const state = await h.service.start();

  /* Then */
  assert.deepEqual(h.link.starts, [{ identity: IDENTITY, port: 0 }]);
  assert.deepEqual(h.advertiser.advertised, [{ name: 'Joris MacBook', port: 52000, txt: { v: String(PROTOCOL_VERSION) } }]);
  assert.equal(state.listening, true);
  assert.equal(state.host, 'joris-mbp.local');
  assert.equal(state.port, 52000);
  assert.deepEqual(h.lastPush(), state);
});

test('turning it on stores the setting and starts listening', async () => {
  /* Given */
  const h = harness();

  /* When */
  const state = await h.service.setEnabled(true);

  /* Then */
  assert.equal(h.store.get(PHONE_ACCESS_ENABLED_KEY), true);
  assert.equal(h.link.starts.length, 1);
  assert.equal(state.enabled, true);
  assert.equal(state.listening, true);
});

test('turning it off closes every connection with turnedOff and withdraws the advertisement', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;

  /* When */
  const state = await h.service.setEnabled(false);

  /* Then */
  assert.equal(h.store.get(PHONE_ACCESS_ENABLED_KEY), false);
  assert.deepEqual(h.link.stops, [CLOSE.turnedOff]);
  assert.equal(phone.closed?.code, CLOSE.turnedOff);
  assert.equal(h.advertiser.withdrawn, 1);
  assert.equal(state.listening, false);
  assert.equal(state.port, null);
  assert.equal(state.devices[0].connected, false);
});

test('a listener that fails to start lands in the error, and turning it on again retries', async () => {
  /* Given */
  const h = harness();
  h.link.failStart = new Error('EADDRINUSE');
  const failed = await h.service.setEnabled(true);
  h.link.failStart = null;

  /* When */
  const retried = await h.service.setEnabled(true);

  /* Then */
  assert.equal(failed.listening, false);
  assert.match(failed.error ?? '', /EADDRINUSE/);
  assert.equal(h.advertiser.advertised.length, 1);
  assert.equal(retried.listening, true);
  assert.equal(retried.error, null);
});

test('a stored key that will not decrypt is shown as an error with Reset as the way out', async () => {
  /* Given */
  const h = harness({ enabled: true });
  h.identity.failLoad = new Error('safeStorage could not decrypt');

  /* When */
  const failed = await h.service.start();
  const reset = await h.service.reset();

  /* Then */
  assert.equal(failed.listening, false);
  assert.match(failed.error ?? '', /could not be read.*Reset/);
  assert.equal(h.link.starts.length, 1);
  assert.equal(h.link.starts[0].identity.certPem, 'cert2');
  assert.equal(reset.listening, true);
  assert.equal(reset.error, null);
});

test('on then off in quick succession ends off', async () => {
  /* Given */
  const h = harness();

  /* When */
  const on = h.service.setEnabled(true);
  const off = h.service.setEnabled(false);
  await on;
  const state = await off;

  /* Then */
  assert.equal(state.listening, false);
  assert.equal(h.link.listening, false);
});

test('restart starts the listener again and phones see it going away', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;

  /* When */
  const state = await h.service.restart();

  /* Then */
  assert.equal(phone.closed?.code, 1001);
  assert.equal(h.link.starts.length, 2);
  assert.equal(h.advertiser.advertised.length, 2);
  assert.equal(state.listening, true);
});

// ── Authorising ──

test('an enrolled certificate gets a device connection and touches its last seen', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  h.setNow(5_000);

  /* When */
  const phone = h.link.connect(PIXEL.fingerprint);

  /* Then */
  assert.deepEqual(phone?.grant, { kind: 'device', deviceId: PIXEL.id });
  assert.equal(h.lastPush().devices[0].lastSeenAt, 5_000);
  assert.equal(h.lastPush().devices[0].connected, true);
});

test('an unknown certificate is refused unless a pairing code is live', async () => {
  /* Given */
  const h = harness({ enabled: true });
  await h.service.start();

  /* When */
  const without = h.link.connect(PHONE_FP);
  h.service.startPairing();
  const during = h.link.connect(PHONE_FP);

  /* Then */
  assert.equal(without, null);
  assert.deepEqual(during?.grant, { kind: 'pairing' });
});

// ── Hello ──

test('hello on an enrolled connection is welcomed and handed to the sessions handler', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;

  /* When */
  h.link.send(phone, { type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });
  h.link.send(phone, { type: 'list-projects' });

  /* Then */
  assert.deepEqual(phone.sent, [{ type: 'welcome', protocol: PROTOCOL_VERSION, macName: 'Joris MacBook', deviceId: PIXEL.id }]);
  assert.deepEqual(h.sessions.events, [
    ['connected', phone.id, { id: PIXEL.id, name: PIXEL.name }],
    ['message', phone.id, { type: 'list-projects' }],
  ]);
});

test('a mismatched protocol gets update-required and close 4001, and never reaches the sessions', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;

  /* When */
  h.link.send(phone, { type: 'hello', protocol: PROTOCOL_VERSION + 1, appVersion: '9.0' });

  /* Then */
  assert.deepEqual(phone.sent, [{ type: 'update-required', protocol: PROTOCOL_VERSION, macVersion: '2.9.0' }]);
  assert.equal(phone.closed?.code, CLOSE.updateRequired);
  assert.deepEqual(h.sessions.events, []);
});

test('anything before hello closes the connection with 4000', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;

  /* When */
  h.link.send(phone, { type: 'list-projects' });

  /* Then */
  assert.equal(phone.closed?.code, CLOSE.protocolError);
  assert.deepEqual(h.sessions.events, []);
});

test('an enrolled connection that disconnects is reported to the sessions handler', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;
  h.link.send(phone, { type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });

  /* When */
  phone.close(1000, 'bye');

  /* Then */
  assert.deepEqual(h.sessions.events.at(-1), ['disconnected', phone.id]);
  assert.equal(h.lastPush().devices[0].connected, false);
});

// ── Pairing ──

test('startPairing shows an invite with the fingerprint, host, port and code', async () => {
  /* Given */
  const h = harness({ enabled: true });
  await h.service.start();

  /* When */
  const state = h.service.startPairing();

  /* Then */
  assert.deepEqual(parseInvite(state.pairing!.invite), {
    protocol: PROTOCOL_VERSION, fingerprint: IDENTITY.fingerprint, code: CODE, host: 'joris-mbp.local', port: 52000,
  });
  assert.equal(state.pairing!.expiresAt, 1_000 + PAIRING_CODE_TTL_MS);
});

test('startPairing does nothing while not listening', async () => {
  /* Given */
  const h = harness();

  /* When */
  const state = h.service.startPairing();

  /* Then */
  assert.equal(state.pairing, null);
});

test('the code expiring clears it from the state and pushes the change', async () => {
  /* Given */
  const h = harness({ enabled: true });
  await h.service.start();
  h.service.startPairing();
  h.setNow(1_000 + PAIRING_CODE_TTL_MS);

  /* When */
  h.timers.tick();

  /* Then */
  assert.equal(h.lastPush().pairing, null);
  assert.equal(h.link.connect(PHONE_FP), null);
});

test('stopPairing clears the code and refuses unknown certificates again', async () => {
  /* Given */
  const h = harness({ enabled: true });
  await h.service.start();
  h.service.startPairing();

  /* When */
  const state = h.service.stopPairing();

  /* Then */
  assert.equal(state.pairing, null);
  assert.equal(h.link.connect(PHONE_FP), null);
});

test('a pairing connection is answered with pairing, not welcome', async () => {
  /* Given */
  const { phone, sessions } = await pairingPhone();

  /* Then */
  assert.deepEqual(phone.sent, [{ type: 'pairing', protocol: PROTOCOL_VERSION, macName: 'Joris MacBook' }]);
  assert.deepEqual(sessions.events, []);
});

test('the right code puts the confirm in the state and answers pair-pending', async () => {
  /* Given */
  const h = await pairingPhone();

  /* When */
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: '  Pixel 9 Pro  ' });

  /* Then */
  assert.deepEqual(h.phone.sent.at(-1), { type: 'pair-pending' });
  assert.equal(h.phone.closed, null);
  assert.deepEqual(h.lastPush().confirm, { requestId: 'id-1', deviceName: 'Pixel 9 Pro' });
  assert.equal(h.lastPush().pairing, null);
});

test('confirming enrols the connection\'s certificate, answers pair-accepted and closes 4005', async () => {
  /* Given */
  const h = await pairingPhone();
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: 'Pixel 9 Pro' });
  h.setNow(7_000);

  /* When */
  const state = h.service.confirmPairing('id-1', true);

  /* Then */
  assert.deepEqual(h.phone.sent.at(-1), { type: 'pair-accepted', deviceId: 'id-2' });
  assert.equal(h.phone.closed?.code, CLOSE.pairingOver);
  assert.deepEqual(h.devices.list(), [{ id: 'id-2', name: 'Pixel 9 Pro', fingerprint: PHONE_FP, pairedAt: 7_000, lastSeenAt: null }]);
  assert.equal(state.confirm, null);
  assert.deepEqual(h.link.connect(PHONE_FP)?.grant, { kind: 'device', deviceId: 'id-2' });
});

test('declining answers pair-rejected declined, closes 4005 and enrols nothing', async () => {
  /* Given */
  const h = await pairingPhone();
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: 'Pixel 9 Pro' });

  /* When */
  const state = h.service.confirmPairing('id-1', false);

  /* Then */
  assert.deepEqual(h.phone.sent.at(-1), { type: 'pair-rejected', reason: 'declined' });
  assert.equal(h.phone.closed?.code, CLOSE.pairingOver);
  assert.deepEqual(h.devices.list(), []);
  assert.equal(state.confirm, null);
});

test('a wrong code is rejected as wrong-code and the connection closed', async () => {
  /* Given */
  const h = await pairingPhone();

  /* When */
  h.link.send(h.phone, { type: 'pair', code: 'ZZZZZZZZ', deviceName: 'Pixel' });

  /* Then */
  assert.deepEqual(h.phone.sent.at(-1), { type: 'pair-rejected', reason: 'wrong-code' });
  assert.equal(h.phone.closed?.code, CLOSE.pairingOver);
  assert.equal(h.lastPush().confirm, null);
});

test('an expired code is rejected as expired', async () => {
  /* Given */
  const h = await pairingPhone();
  h.setNow(1_000 + PAIRING_CODE_TTL_MS);

  /* When */
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: 'Pixel' });

  /* Then */
  assert.deepEqual(h.phone.sent.at(-1), { type: 'pair-rejected', reason: 'expired' });
  assert.equal(h.phone.closed?.code, CLOSE.pairingOver);
});

test('too many wrong codes lock pairing out, even for the right code', async () => {
  /* Given */
  const h = harness({ enabled: true });
  await h.service.start();
  h.service.startPairing();
  const guess = () => {
    const phone = h.link.connect(PHONE_FP)!;
    h.link.send(phone, { type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });
    return phone;
  };
  for (let i = 0; i < PAIRING_MAX_FAILURES - 1; i++) h.link.send(guess(), { type: 'pair', code: 'ZZZZZZZZ', deviceName: 'x' });
  const last = guess();
  h.link.send(last, { type: 'pair', code: 'ZZZZZZZZ', deviceName: 'x' });

  /* When */
  const right = guess();
  h.link.send(right, { type: 'pair', code: CODE, deviceName: 'Pixel' });

  /* Then */
  assert.deepEqual(last.sent.at(-1), { type: 'pair-rejected', reason: 'locked-out' });
  assert.deepEqual(right.sent.at(-1), { type: 'pair-rejected', reason: 'locked-out' });
  assert.equal(h.lastPush().confirm, null);
});

test('a second phone with the same code finds pairing over', async () => {
  /* Given */
  const h = await pairingPhone();
  const other = h.link.connect(PHONE_FP)!;
  h.link.send(other, { type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: 'Pixel' });

  /* When */
  h.link.send(other, { type: 'pair', code: CODE, deviceName: 'Intruder' });

  /* Then */
  assert.deepEqual(other.sent.at(-1), { type: 'pair-rejected', reason: 'not-pairing' });
  assert.deepEqual(h.lastPush().confirm, { requestId: 'id-1', deviceName: 'Pixel' });
});

test('a pairing connection that sends anything but hello and pair is closed with 4000', async () => {
  /* Given */
  const h = await pairingPhone();

  /* When */
  h.link.send(h.phone, { type: 'list-projects' });

  /* Then */
  assert.equal(h.phone.closed?.code, CLOSE.protocolError);
  assert.deepEqual(h.sessions.events, []);
});

test('a second pair on the same connection is closed with 4000', async () => {
  /* Given */
  const h = await pairingPhone();
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: 'Pixel' });

  /* When */
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: 'Pixel' });

  /* Then */
  assert.equal(h.phone.closed?.code, CLOSE.protocolError);
});

test('the phone hanging up while the confirm shows clears it', async () => {
  /* Given */
  const h = await pairingPhone();
  h.link.send(h.phone, { type: 'pair', code: CODE, deviceName: 'Pixel' });

  /* When */
  h.phone.close(1000, 'bye');
  const state = h.service.confirmPairing('id-1', true);

  /* Then */
  assert.equal(h.lastPush().confirm, null);
  assert.deepEqual(state.devices, []);
});

// ── Devices ──

test('revoking a device removes it, tells its connection and closes it with 4003', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;
  h.link.send(phone, { type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });

  /* When */
  const state = h.service.revoke(PIXEL.id);

  /* Then */
  assert.deepEqual(phone.sent.at(-1), { type: 'revoked' });
  assert.equal(phone.closed?.code, CLOSE.notPaired);
  assert.deepEqual(state.devices, []);
  assert.deepEqual(h.sessions.events.slice(-2), [['disconnected', phone.id], ['deviceRemoved', PIXEL.id]]);
  assert.equal(h.link.connect(PIXEL.fingerprint), null);
});

test('reset makes a new identity, un-pairs everyone and listens again with the new certificate', async () => {
  /* Given */
  const other: EnrolledDevice = { ...PIXEL, id: 'dev-other', fingerprint: 'd'.repeat(64) };
  const h = harness({ enabled: true, devices: [PIXEL, other] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;
  h.link.send(phone, { type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });

  /* When */
  const state = await h.service.reset();

  /* Then */
  assert.deepEqual(phone.sent.at(-1), { type: 'revoked' });
  assert.equal(phone.closed?.code, CLOSE.notPaired);
  assert.deepEqual(state.devices, []);
  assert.deepEqual(h.sessions.events.filter((e) => e[0] === 'deviceRemoved'), [['deviceRemoved', PIXEL.id], ['deviceRemoved', other.id]]);
  assert.equal(h.link.starts.at(-1)?.identity.certPem, 'cert2');
  assert.equal(state.listening, true);
  assert.equal(h.service.startPairing().pairing !== null, true);
  assert.equal(parseInvite(h.service.state().pairing!.invite)?.fingerprint, '1'.repeat(64));
});

test('reset while off makes a new identity without listening', async () => {
  /* Given */
  const h = harness({ devices: [PIXEL] });

  /* When */
  const state = await h.service.reset();

  /* Then */
  assert.deepEqual(state.devices, []);
  assert.equal(h.link.starts.length, 0);
  assert.equal(state.listening, false);
});

test('shutdown closes connections as going away and keeps the setting', async () => {
  /* Given */
  const h = harness({ enabled: true, devices: [PIXEL] });
  await h.service.start();
  const phone = h.link.connect(PIXEL.fingerprint)!;

  /* When */
  await h.service.shutdown();

  /* Then */
  assert.equal(phone.closed?.code, 1001);
  assert.equal(h.advertiser.withdrawn, 1);
  assert.equal(h.store.get(PHONE_ACCESS_ENABLED_KEY), true);
});

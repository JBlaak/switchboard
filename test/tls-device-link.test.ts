import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { CLOSE } from '../src/domain/phone/protocol';
import type { ClientMessage } from '../src/domain/phone/protocol';
import type {
  ConnectionGrant, DeviceConnection, DeviceLinkHandlers, ServerIdentity,
} from '../src/application/ports/phone-access';
import { TlsDeviceLink, lanAddresses } from '../src/infrastructure/phone/tls-device-link';
import { silentLog } from './support/fakes';

/**
 * The listener against real sockets: real TLS 1.3, real client certificates,
 * a real `ws` client. The certificates are throwaways made with `openssl`
 * here, and the listener is bound to loopback for the test only.
 */

interface Pair { keyPem: string; certPem: string; fingerprint: string }

let dir: string;
let server: ServerIdentity;
let phone: Pair;
let stranger: Pair;

function makePair(name: string): Pair {
  const key = path.join(dir, `${name}.key`);
  const cert = path.join(dir, `${name}.crt`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', `/CN=${name}`,
  ], { stdio: 'ignore' });
  const certPem = fs.readFileSync(cert, 'utf8');
  return {
    keyPem: fs.readFileSync(key, 'utf8'),
    certPem,
    fingerprint: new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase(),
  };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-device-link-'));
  server = makePair('mac');
  phone = makePair('phone');
  stranger = makePair('stranger');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A JSON codec standing in for the domain one. */
function parse(text: string): ClientMessage | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value.type === 'string' ? value as ClientMessage : null;
  } catch {
    return null;
  }
}

/** The protocol.ts layout: u16 id length, id, output. */
function encodeTerminalFrame(sessionId: string, data: string): Uint8Array {
  const id = Buffer.from(sessionId, 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(id.length);
  return Buffer.concat([head, id, Buffer.from(data, 'utf8')]);
}

function recordingHandlers(grant: (fingerprint: string) => ConnectionGrant) {
  const asked: string[] = [];
  const connections: DeviceConnection[] = [];
  const messages: ClientMessage[] = [];
  const disconnected: DeviceConnection[] = [];
  const handlers: DeviceLinkHandlers = {
    authorize: (fingerprint) => { asked.push(fingerprint); return grant(fingerprint); },
    connected: (c) => { connections.push(c); },
    message: (_c, m) => { messages.push(m); },
    disconnected: (c) => { disconnected.push(c); },
  };
  return { handlers, asked, connections, messages, disconnected };
}

async function harness(options: { keepaliveMs?: number } = {}) {
  const link = new TlsDeviceLink({
    parse, encodeTerminalFrame, log: silentLog, addresses: () => ['127.0.0.1'], ...options,
  });
  const rec = recordingHandlers((fp) => (fp === phone.fingerprint ? { kind: 'device', deviceId: 'd1' } : null));
  const port = await link.start(server, 0, rec.handlers);
  return { link, port, ...rec };
}

function connect(port: number, pair: Pair | null, extra: Record<string, unknown> = {}): WebSocket {
  return new WebSocket(`wss://127.0.0.1:${port}`, {
    rejectUnauthorized: false,
    ...(pair ? { key: pair.keyPem, cert: pair.certPem } : {}),
    ...extra,
  });
}

/** Resolves with whether the socket opened before it closed or failed. */
function outcome(ws: WebSocket): Promise<'open' | 'failed'> {
  return new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('error', () => resolve('failed'));
    ws.once('close', () => resolve('failed'));
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) => ws.once('message', (data, isBinary) => resolve({ data: data as Buffer, isBinary })));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(predicate(), 'condition never became true');
}

test('a client without a certificate never gets a WebSocket', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.link.stop(1001, 'test over'));

  /* When */
  const result = await outcome(connect(h.port, null));

  /* Then */
  assert.equal(result, 'failed');
  assert.deepEqual(h.asked, []);
  assert.deepEqual(h.connections, []);
});

test('a certificate authorize refuses never gets a WebSocket', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.link.stop(1001, 'test over'));

  /* When */
  const result = await outcome(connect(h.port, stranger));

  /* Then */
  assert.equal(result, 'failed');
  assert.deepEqual(h.asked, [stranger.fingerprint]);
  assert.deepEqual(h.connections, []);
});

test('an authorised client exchanges text both ways and receives terminal frames', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.link.stop(1001, 'test over'));
  const ws = connect(h.port, phone);
  assert.equal(await outcome(ws), 'open');
  await until(() => h.connections.length === 1);
  const connection = h.connections[0];

  /* When */
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, appVersion: '1.0' }));
  await until(() => h.messages.length === 1);
  const text = nextMessage(ws);
  connection.send({ type: 'welcome', protocol: 1, macName: 'Mac', deviceId: 'd1' });
  const welcome = await text;
  const binary = nextMessage(ws);
  connection.sendTerminal('s1', 'héllo');
  const frame = await binary;

  /* Then */
  assert.equal(connection.fingerprint, phone.fingerprint);
  assert.deepEqual(connection.grant, { kind: 'device', deviceId: 'd1' });
  assert.deepEqual(h.messages, [{ type: 'hello', protocol: 1, appVersion: '1.0' }]);
  assert.equal(welcome.isBinary, false);
  assert.deepEqual(JSON.parse(welcome.data.toString('utf8')), { type: 'welcome', protocol: 1, macName: 'Mac', deviceId: 'd1' });
  assert.equal(frame.isBinary, true);
  assert.deepEqual(frame.data, Buffer.from(encodeTerminalFrame('s1', 'héllo')));
});

test('a malformed text frame closes the connection with the protocol error code', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.link.stop(1001, 'test over'));
  const ws = connect(h.port, phone);
  assert.equal(await outcome(ws), 'open');
  const code = closed(ws);

  /* When */
  ws.send('{not json');

  /* Then */
  assert.equal(await code, CLOSE.protocolError);
  assert.deepEqual(h.messages, []);
  await until(() => h.disconnected.length === 1);
});

test('a binary frame from the phone is a protocol error', async (t) => {
  /* Given */
  const h = await harness();
  t.after(() => h.link.stop(1001, 'test over'));
  const ws = connect(h.port, phone);
  assert.equal(await outcome(ws), 'open');
  const code = closed(ws);

  /* When */
  ws.send(Buffer.from([1, 2, 3]), { binary: true });

  /* Then */
  assert.equal(await code, CLOSE.protocolError);
  assert.deepEqual(h.messages, []);
});

test('stop closes every connection with its code and stops listening', async () => {
  /* Given */
  const h = await harness();
  const first = connect(h.port, phone);
  const second = connect(h.port, phone);
  assert.equal(await outcome(first), 'open');
  assert.equal(await outcome(second), 'open');
  const codes = Promise.all([closed(first), closed(second)]);

  /* When */
  await h.link.stop(CLOSE.turnedOff, 'Phone access was turned off');

  /* Then */
  assert.deepEqual(await codes, [CLOSE.turnedOff, CLOSE.turnedOff]);
  assert.equal(h.link.listening, false);
  assert.equal(await outcome(connect(h.port, phone)), 'failed');
  await until(() => h.disconnected.length === 2);
});

test('a peer that stops answering pings is dropped', async (t) => {
  /* Given */
  const h = await harness({ keepaliveMs: 20 });
  t.after(() => h.link.stop(1001, 'test over'));
  const answering = connect(h.port, phone);
  const silent = connect(h.port, phone, { autoPong: false });
  assert.equal(await outcome(answering), 'open');
  assert.equal(await outcome(silent), 'open');

  /* When */
  const code = await closed(silent);

  /* Then */
  assert.equal(code, 1006);
  assert.equal(answering.readyState, WebSocket.OPEN);
  answering.close();
});

test('the LAN addresses leave out loopback, tunnels, VPNs and CGNAT', () => {
  /* Given */
  const v4 = (address: string, internal = false) => ({ address, netmask: '', family: 'IPv4' as const, mac: '', internal, cidr: null });
  const v6 = (address: string) => ({ address, netmask: '', family: 'IPv6' as const, mac: '', internal: false, cidr: null, scopeid: 0 });
  const interfaces = {
    lo0: [v4('127.0.0.1', true)],
    en0: [v4('192.168.1.20'), v6('fe80::1c2b:3a4d'), v6('2a02:a45::5')],
    en7: [v4('100.72.1.2')],
    utun4: [v4('10.8.0.2')],
    ipsec0: [v4('10.9.0.2')],
    awdl0: [v6('fe80::99')],
    bridge100: [v4('192.168.2.1')],
  };

  /* When */
  const addresses = lanAddresses(interfaces);

  /* Then */
  assert.deepEqual(addresses, ['192.168.1.20', 'fe80::1c2b:3a4d%en0', '2a02:a45::5']);
});

test('starting with nowhere to listen fails', async () => {
  /* Given */
  const link = new TlsDeviceLink({ parse, encodeTerminalFrame, log: silentLog, addresses: () => [] });

  /* When */
  const started = link.start(server, 0, recordingHandlers(() => null).handlers);

  /* Then */
  await assert.rejects(started, /No local network interface/);
  assert.equal(link.listening, false);
});

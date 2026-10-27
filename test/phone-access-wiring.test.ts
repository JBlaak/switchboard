import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { QuestionService } from '../src/application/services/question-service';
import { CLOSE, PROTOCOL_VERSION } from '../src/domain/phone/protocol';
import { decodeTerminalFrame, parseInvite } from '../src/domain/phone/codec';
import { HIDE_CURSOR } from '../src/domain/terminal/ansi';
import { OpensslIdentityStore } from '../src/infrastructure/phone/identity-store';
import { systemTimers } from '../src/infrastructure/system/timers';
import { INVOKE, SEND } from '../src/ipc/channels';
import { PhoneEventTee, buildPhoneAccess } from '../src/main/phone-access';
import { registerPhoneAccessHandlers } from '../src/main/ipc/phone-access-handlers';
import { registerQuestionHandlers } from '../src/main/ipc/question-handlers';
import { registerSessionHandlers } from '../src/main/ipc/session-handlers';
import { sessionArchiver } from '../src/main/stop-session';
import { registerTerminalHandlers } from '../src/main/ipc/terminal-handlers';
import { fakeRenderer, resizingPty, silentLog } from './support/fakes';
import type { FakeRenderer } from './support/fakes';
import type { DeviceRegistry, EnrolledDevice, ServiceAdvertiser } from '../src/application/ports/phone-access';
import type { OpenSessionRequest } from '../src/application/services/session-launcher';
import type { ClientMessage, ServerMessage } from '../src/domain/phone/protocol';
import type { PhoneAccessState } from '../src/domain/phone/state';
import type { Project } from '../src/domain/project/project';
import type { Container } from '../src/main/composition-root';
import type { SessionStopper } from '../src/main/stop-session';
import type { IpcRegistrar } from '../src/main/ipc/registrar';

/**
 * Phone access wired the way the app wires it (`main/phone-access`), against
 * a real listener: real TLS 1.3 on loopback, the real identity store making a
 * real key with openssl, and a scripted phone presenting an openssl-made
 * client certificate. The Mac's side goes through the real IPC handlers on a
 * recording registrar. What stands in: the PTYs, the device table (SQLite is
 * built for Electron's ABI) and the advertiser.
 */

const APP = '/code/app';

interface Pair { keyPem: string; certPem: string; fingerprint: string }

let dir: string;
let phoneCert: Pair;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-wiring-'));
  const key = path.join(dir, 'phone.key');
  const cert = path.join(dir, 'phone.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=Pixel 9 Pro',
  ], { stdio: 'ignore' });
  const certPem = fs.readFileSync(cert, 'utf8');
  phoneCert = {
    keyPem: fs.readFileSync(key, 'utf8'),
    certPem,
    fingerprint: new crypto.X509Certificate(certPem).fingerprint256.replace(/:/g, '').toLowerCase(),
  };
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ── The Mac ──

function memoryDevices(): DeviceRegistry {
  let devices: EnrolledDevice[] = [];
  return {
    list: () => devices.map(device => ({ ...device })),
    findByFingerprint: (fingerprint) => devices.find(device => device.fingerprint === fingerprint) ?? null,
    add: (device) => { devices.push({ ...device }); },
    remove: (id) => { devices = devices.filter(device => device.id !== id); },
    touch: (id, at) => { for (const device of devices) if (device.id === id) device.lastSeenAt = at; },
    clear: () => { devices = []; },
  };
}

function recordingAdvertiser() {
  const calls: string[] = [];
  const advertiser: ServiceAdvertiser = {
    advertise: (name, port, txt) => { calls.push(`advertise ${name} ${port} v=${txt.v}`); },
    withdraw: () => { calls.push('withdraw'); },
    hostName: () => '127.0.0.1',
  };
  return { advertiser, calls };
}

/** The IPC handlers' registrar, with a way to call what they registered as the renderer would. */
function recordingRegistrar() {
  const invokes = new Map<string, (...args: unknown[]) => unknown>();
  const sends = new Map<string, (...args: unknown[]) => void>();
  const ipc: IpcRegistrar = {
    handle: (channel, handler) => { invokes.set(channel, handler as (...args: unknown[]) => unknown); },
    on: (channel, handler) => { sends.set(channel, handler as (...args: unknown[]) => void); },
  };
  return {
    ipc,
    invoke: async <T>(channel: string, ...args: unknown[]) => await invokes.get(channel)!(...args) as T,
    send: (channel: string, ...args: unknown[]) => sends.get(channel)!(...args),
  };
}

async function mac() {
  const registry = new SessionRegistry();
  const window: FakeRenderer = fakeRenderer();
  let sessions: ReturnType<typeof buildPhoneAccess>['sessions'] | null = null;
  const renderer = new PhoneEventTee(window, () => sessions);
  const settings = new Map<string, unknown>();
  const advertised = recordingAdvertiser();
  const launches: OpenSessionRequest[] = [];
  const projects: Project[] = [{ projectPath: APP, folder: '-code-app', sessions: [] }];
  let ids = 0;

  const addSession = (id: string) => {
    const pty = resizingPty();
    registry.add(id, new ActiveSession({
      pty, projectPath: APP, projectFolder: '-code-app', knownTranscriptIds: new Set(),
      sessionSlug: null, isPlainTerminal: false, remote: null, openedAt: 1_000,
    }));
    return pty;
  };

  const questions = new QuestionService({
    registry, renderer,
    endpoint: { url: 'http://127.0.0.1:4000', token: 't' },
    prompter: { send() {}, onExit: () => ({ dispose() {} }) },
    clock: { now: () => Date.now() },
    log: silentLog,
  });
  const launcher = {
    async open(request: OpenSessionRequest) {
      launches.push(request);
      if (!registry.get(request.sessionId)) addSession(request.sessionId);
      return { ok: true, reattached: false };
    },
  };

  // Stopping a session ends it at once, as a kill that lands would.
  const archived = new Set<string>();
  const stopper: SessionStopper = {
    registry,
    remote: {} as SessionStopper['remote'],
    lifecycle: {
      stop: (key: string, session: ActiveSession) => { session.exited = true; renderer.processExited(key, 0); },
      retire: (key: string, session: ActiveSession) => { session.exited = true; renderer.processExited(key, 0); },
    } as unknown as SessionStopper['lifecycle'],
    terminals: { isAlive: () => true } as unknown as SessionStopper['terminals'],
  };
  const repository = {
    setArchived: (id: string, value: boolean) => { if (value) archived.add(id); else archived.delete(id); },
  };

  const devices = memoryDevices();
  const worktreeCleanup = { afterArchive: async () => {} };
  const phone = buildPhoneAccess({
    identity: new OpensslIdentityStore({
      directory: path.join(dir, `identity-${crypto.randomUUID()}`),
      encryption: { encrypt: (text) => Buffer.from(text), decrypt: (data) => data.toString() },
    }),
    devices,
    advertiser: advertised.advertiser,
    addresses: () => ['127.0.0.1'],
    registry,
    running: { runningSessionIds: () => registry.snapshot().filter(([, s]) => !s.exited).map(([id]) => id) },
    projects: { list: () => projects },
    questions,
    router: () => ({ route: async () => ({ kind: 'cancelled' as const }), cancel() {} }),
    launcher,
    archiver: sessionArchiver({ ...stopper, repository, renderer, worktreeCleanup }),
    settings: {
      get: <T>(key: string) => (settings.get(key) ?? null) as T | null,
      set: (key: string, value: unknown) => { settings.set(key, value); },
      effective: () => ({ permissionMode: 'auto', worktree: false }),
    },
    renderer,
    voice: {
      transcriber: { available: async () => true, transcribe: async () => ' um, fix the login\n' },
      model: { path: '/models/whisper.bin', present: async () => true, download: async () => {} },
      cli: {
        call: async () => ({ exitCode: 0, stdout: JSON.stringify({ type: 'result', result: 'Fix the login.' }), stderr: '' }),
        warm() { throw new Error('not warmed'); },
      },
    },
    ids: { newId: () => `id-${++ids}` },
    clock: { now: () => Date.now() },
    timers: systemTimers,
    log: silentLog,
    randomBytes: (length) => crypto.randomBytes(length),
    macName: 'Joris’s MacBook Pro',
    appVersion: '9.9.9',
  });
  sessions = phone.sessions;

  const ipc = recordingRegistrar();
  const app = {
    ...stopper, repository, renderer, launcher, questions, phoneAccess: phone.access, phoneSessions: phone.sessions,
    worktreeCleanup,
  } as unknown as Container;
  registerTerminalHandlers(ipc.ipc, app);
  registerSessionHandlers(ipc.ipc, app);
  registerQuestionHandlers(ipc.ipc, app);
  registerPhoneAccessHandlers(ipc.ipc, app);

  return { ...phone, registry, devices, window, renderer, questions, advertised, launches, addSession, ipc, archived };
}

// ── The phone ──

type Received = ServerMessage | { type: 'frame'; sessionId: string; data: string };

/** A phone app reduced to its socket: connects with its certificate, sends messages, waits for what comes back. */
class ScriptedPhone {
  readonly received: Received[] = [];
  serverFingerprint: string | null = null;
  readonly closed: Promise<number>;
  readonly #ws: WebSocket;

  constructor(port: number, cert: Pair) {
    this.#ws = new WebSocket(`wss://127.0.0.1:${port}`, { key: cert.keyPem, cert: cert.certPem, rejectUnauthorized: false });
    this.#ws.on('upgrade', (response) => {
      const raw = (response.socket as import('node:tls').TLSSocket).getPeerCertificate().raw;
      this.serverFingerprint = crypto.createHash('sha256').update(raw).digest('hex');
    });
    this.#ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodeTerminalFrame(new Uint8Array(data as Buffer));
        if (frame) this.received.push({ type: 'frame', ...frame });
      } else {
        this.received.push(JSON.parse((data as Buffer).toString('utf8')) as ServerMessage);
      }
    });
    this.closed = new Promise((resolve) => this.#ws.once('close', (code) => resolve(code)));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#ws.once('open', () => resolve());
      this.#ws.once('error', reject);
    });
  }

  send(message: ClientMessage): void {
    this.#ws.send(JSON.stringify(message));
  }

  /** The first message of that type, once it has arrived. */
  async next<T extends Received['type']>(type: T): Promise<Extract<Received, { type: T }>> {
    await until(() => this.received.some(message => message.type === type), `a ${type} message`);
    return this.received.find(message => message.type === type) as Extract<Received, { type: T }>;
  }

  of<T extends Received['type']>(type: T): Extract<Received, { type: T }>[] {
    return this.received.filter(message => message.type === type) as Extract<Received, { type: T }>[];
  }

  output(sessionId: string): string {
    return this.of('frame').filter(frame => frame.sessionId === sessionId).map(frame => frame.data).join('');
  }

  clear(): void {
    this.received.length = 0;
  }

  close(): void {
    this.#ws.close(1000, 'done');
  }
}

/** Long enough for a resize's repaint nudge (two 50 ms steps) to have run. */
const nudged = () => new Promise((resolve) => setTimeout(resolve, 150));

async function until(predicate: () => boolean, what = 'the condition'): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), `${what} never came`);
}

/** A phone already paired and connected, welcomed and sent the list. */
async function pairedPhone(m: Awaited<ReturnType<typeof mac>>): Promise<ScriptedPhone> {
  const state = await m.ipc.invoke<PhoneAccessState>(INVOKE.phoneAccessSetEnabled, true);
  m.devices.add({ id: 'pixel', name: 'Pixel 9 Pro', fingerprint: phoneCert.fingerprint, pairedAt: 1, lastSeenAt: null });
  const phone = new ScriptedPhone(state.port!, phoneCert);
  await phone.opened();
  phone.send({ type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });
  await phone.next('sessions');
  return phone;
}

// ── The journeys ──

test('a phone pairs with the code on the Mac, is confirmed, and reconnects enrolled to the session list', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  m.addSession('s1');
  const on = await m.ipc.invoke<PhoneAccessState>(INVOKE.phoneAccessSetEnabled, true);
  const pairing = await m.ipc.invoke<PhoneAccessState>(INVOKE.phoneAccessStartPairing);
  const invite = parseInvite(pairing.pairing!.invite)!;

  /* When */
  const pairer = new ScriptedPhone(invite.port, phoneCert);
  await pairer.opened();
  pairer.send({ type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });
  await pairer.next('pairing');
  pairer.send({ type: 'pair', code: invite.code, deviceName: 'Pixel 9 Pro' });
  await pairer.next('pair-pending');

  /* Then */
  assert.equal(on.listening, true);
  assert.deepEqual(m.advertised.calls, [`advertise Joris’s MacBook Pro ${on.port} v=${PROTOCOL_VERSION}`]);
  assert.equal(pairer.serverFingerprint, invite.fingerprint);
  const asking = m.access.state().confirm!;
  assert.equal(asking.deviceName, 'Pixel 9 Pro');
  assert.deepEqual(m.window.only('phoneAccessChanged').at(-1)?.[1], m.access.state());

  /* When */
  const confirmed = await m.ipc.invoke<PhoneAccessState>(INVOKE.phoneAccessConfirmPairing, asking.requestId, true);
  const accepted = await pairer.next('pair-accepted');
  await pairer.closed;
  const phone = new ScriptedPhone(invite.port, phoneCert);
  await phone.opened();
  phone.send({ type: 'hello', protocol: PROTOCOL_VERSION, appVersion: '1.0' });
  const welcome = await phone.next('welcome');
  const list = await phone.next('sessions');

  /* Then */
  assert.equal(confirmed.confirm, null);
  assert.deepEqual(confirmed.devices.map(device => device.name), ['Pixel 9 Pro']);
  assert.deepEqual(welcome, { type: 'welcome', protocol: PROTOCOL_VERSION, macName: 'Joris’s MacBook Pro', deviceId: accepted.deviceId });
  assert.deepEqual(list.sessions.map(session => [session.id, session.owner]), [['s1', { kind: 'mac' }]]);
  await until(() => m.access.state().devices[0]?.connected === true, 'the connected device');

  /* When */
  await m.ipc.invoke(INVOKE.phoneAccessSetEnabled, false);

  /* Then */
  assert.equal(await phone.closed, CLOSE.turnedOff);
  assert.equal(m.advertised.calls.at(-1), 'withdraw');
  assert.equal(m.access.state().listening, false);
});

test('an attached phone gets the replay and the stream, types into the PTY, and ownership moves between it and the Mac', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  const pty = m.addSession('s1');
  m.registry.get('s1')!.output.append('earlier output ');
  m.ipc.send(SEND.terminalResize, 's1', 120, 40);
  await nudged();
  const phone = await pairedPhone(m);
  phone.clear();

  /* When */
  phone.send({ type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  const attached = await phone.next('attached');
  m.renderer.terminalData('s1', 'live output');
  await until(() => phone.output('s1').includes('live output'), 'the live output');

  /* Then */
  assert.deepEqual(attached.owner, { kind: 'mac' });
  assert.equal(phone.output('s1'), `earlier output ${HIDE_CURSOR}live output`);

  /* When */
  phone.send({ type: 'input', sessionId: 's1', data: 'not yet' });
  phone.send({ type: 'use-here', sessionId: 's1' });
  const owner = await phone.next('owner');
  phone.send({ type: 'input', sessionId: 's1', data: 'from the phone\r' });
  await until(() => pty.writes.length > 0, 'the phone’s input');
  await nudged();

  /* Then */
  assert.deepEqual(owner, { type: 'owner', sessionId: 's1', owner: { kind: 'device', deviceId: 'pixel', name: 'Pixel 9 Pro' } });
  assert.deepEqual(pty.writes, ['from the phone\r']);
  assert.deepEqual(pty.resizes[pty.resizes.length - 1], [40, 20]);
  assert.deepEqual(m.window.only('terminalOwnerChanged'), [['terminalOwnerChanged', 's1', { kind: 'device', deviceId: 'pixel', name: 'Pixel 9 Pro' }]]);
  assert.deepEqual(await m.ipc.invoke(INVOKE.terminalOwners), { s1: { kind: 'device', deviceId: 'pixel', name: 'Pixel 9 Pro' } });

  /* When */
  const resizesBefore = pty.resizes.length;
  m.ipc.send(SEND.terminalInput, 's1', 'from the mac');
  m.ipc.send(SEND.terminalResize, 's1', 100, 30);

  /* Then */
  assert.deepEqual(pty.writes, ['from the phone\r']);
  assert.equal(pty.resizes.length, resizesBefore);

  /* When */
  phone.clear();
  // What the placeholder's Use here does: the call, then the window's size.
  const usedHere = await m.ipc.invoke(INVOKE.useTerminalHere, 's1');
  m.ipc.send(SEND.terminalResize, 's1', 100, 30);
  m.ipc.send(SEND.terminalInput, 's1', 'back on the mac');
  const back = await phone.next('owner');
  await nudged();

  /* Then */
  assert.deepEqual(usedHere, { ok: true });
  assert.deepEqual(back.owner, { kind: 'mac' });
  assert.deepEqual(pty.resizes.slice(resizesBefore), [[100, 30], [100, 30], [101, 30], [100, 30]]);
  assert.deepEqual(pty.writes, ['from the phone\r', 'back on the mac']);

  /* When */
  m.ipc.send(SEND.terminalResize, 's1', 110, 35);

  /* Then */
  assert.deepEqual(pty.resizes.at(-1), [110, 35]);

  /* When */
  phone.send({ type: 'input', sessionId: 's1', data: 'dropped' });
  phone.send({ type: 'size', sessionId: 's1', cols: 41, rows: 21 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  /* Then */
  assert.deepEqual(pty.writes, ['from the phone\r', 'back on the mac']);
  assert.deepEqual(pty.resizes.at(-1), [110, 35]);
  phone.close();
});

test('a question answered on the Mac reaches the phone as answered on the Mac; one answered on the phone moves the session to it', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  m.addSession('s1');
  const phone = await pairedPhone(m);
  const ask = (toolUseId: string) => ({
    toolUseId,
    questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
    toolInput: {},
  });
  phone.clear();

  /* When */
  m.questions.receive('s1', ask('tu-1'), () => {});
  await until(() => phone.of('questions').some(message => message.pending.length === 1), 'the question');
  const result = await m.ipc.invoke(INVOKE.answerQuestions, 's1', 'tu-1', { 'Which store?': 'A' });
  const settled = await phone.next('questions-settled');

  /* Then */
  assert.deepEqual(result, { ok: true });
  assert.equal(settled.answeredOn, 'mac');

  /* When */
  phone.clear();
  m.questions.receive('s1', ask('tu-2'), () => {});
  await until(() => phone.of('questions').some(message => message.pending.length === 1), 'the second question');
  phone.send({ type: 'answer', sessionId: 's1', toolUseId: 'tu-2', answers: { 'Which store?': 'B' } });
  const answerResult = await phone.next('answer-result');
  const owner = await phone.next('owner');

  /* Then */
  assert.equal(answerResult.ok, true);
  assert.deepEqual(owner.owner, { kind: 'device', deviceId: 'pixel', name: 'Pixel 9 Pro' });
  assert.deepEqual(m.window.only('questionsSettled').at(-1)?.[1], { sessionId: 's1', toolUseId: 'tu-2', outcome: 'answered', answeredOn: 'phone' });
  phone.close();
});

test('a session a phone starts is given a row on the Mac at once, owned by the phone', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  const phone = await pairedPhone(m);

  /* When */
  phone.send({ type: 'ask-start', requestId: 'r1', projectPath: APP, prompt: 'Fix the login', cols: 40, rows: 20 });
  const started = await phone.next('ask-started');
  await until(() => phone.of('sessions').some(list => list.sessions.length === 1), 'the new session in the list');

  /* Then */
  assert.equal(m.launches[0].options?.initialPrompt, 'Fix the login');
  assert.deepEqual(m.window.only('sessionStarted'), [['sessionStarted', started.sessionId, APP]]);
  assert.deepEqual(m.window.only('terminalOwnerChanged'), [['terminalOwnerChanged', started.sessionId, { kind: 'device', deviceId: 'pixel', name: 'Pixel 9 Pro' }]]);
  phone.close();
});

test('a session archived on the Mac leaves the phone: it ends, is pushed as archived, and drops off the list', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  m.addSession('s1');
  const phone = await pairedPhone(m);
  await until(() => phone.of('sessions').at(-1)?.sessions.length === 1, 's1 in the list');
  phone.send({ type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  await phone.next('attached');

  /* When */
  // What the renderer's archive does (`archiveSessionRow`): stop, then archive the row.
  await m.ipc.invoke(INVOKE.stopSession, 's1');
  await m.ipc.invoke(INVOKE.archiveSession, 's1', true);

  /* Then */
  assert.deepEqual(await phone.next('archived'), { type: 'archived', sessionId: 's1' });
  await until(() => phone.of('sessions').at(-1)?.sessions.length === 0, 's1 off the list');
  assert.deepEqual(phone.of('exited'), [{ type: 'exited', sessionId: 's1', exitCode: 0 }]);
  assert.ok(m.archived.has('s1'));
  phone.close();
});

test('a session archived on a phone leaves the Mac and every other phone', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  m.addSession('s1');
  const phone = await pairedPhone(m);
  await until(() => phone.of('sessions').at(-1)?.sessions.length === 1, 's1 in the list');

  /* When */
  phone.send({ type: 'archive', sessionId: 's1' });

  /* Then */
  assert.deepEqual(await phone.next('archive-result'), { type: 'archive-result', sessionId: 's1', ok: true });
  assert.deepEqual(await phone.next('archived'), { type: 'archived', sessionId: 's1' });
  await until(() => phone.of('sessions').at(-1)?.sessions.length === 0, 's1 off the list');
  assert.ok(m.archived.has('s1'));
  assert.deepEqual(m.window.only('sessionArchived'), [['sessionArchived', 's1']]);
  phone.close();
});

test('bringing a session back on the Mac pushes nothing to the phones', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  const phone = await pairedPhone(m);
  phone.clear();

  /* When */
  await m.ipc.invoke(INVOKE.archiveSession, 's1', false);
  await nudged();

  /* Then */
  assert.deepEqual(phone.of('archived'), []);
  phone.close();
});

/** 200 ms of a 200 Hz tone, loud enough that the Mac takes it for speech. */
function speechLevelTone(): Buffer {
  const audio = Buffer.alloc(6400);
  for (let i = 0; i < 3200; i++) audio.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 200 * i) / 16_000)), i * 2);
  return audio;
}

test('a phone that holds the mic gets the voice status on welcome and the cleaned-up text when it lets go', async (t) => {
  /* Given */
  const m = await mac();
  t.after(() => m.access.shutdown());
  const phone = await pairedPhone(m);
  const status = await phone.next('voice-status');

  /* When */
  phone.send({ type: 'voice-start', voiceId: 'v1' });
  phone.send({ type: 'voice-chunk', voiceId: 'v1', seq: 0, audio: speechLevelTone().toString('base64') });
  phone.send({ type: 'voice-end', voiceId: 'v1' });
  const result = await phone.next('voice-result');

  /* Then */
  assert.deepEqual(status, { type: 'voice-status', status: { kind: 'ready' } });
  assert.deepEqual(result, { type: 'voice-result', voiceId: 'v1', result: { kind: 'text', text: 'Fix the login.' } });
  phone.close();
});

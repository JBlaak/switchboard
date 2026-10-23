import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ActiveSession } from '../src/application/model/active-session';
import { SessionRegistry } from '../src/application/model/session-registry';
import { ASK_PATCH_CALL, AskRouteService } from '../src/application/services/ask-route-service';
import { PhoneSessionsService } from '../src/application/services/phone-sessions-service';
import { QuestionService } from '../src/application/services/question-service';
import { ENTER_ALT_SCREEN, HIDE_CURSOR } from '../src/domain/terminal/ansi';
import { fakeDeviceConnection, fakeRenderer, fakeTimers, resizingPty, silentLog } from './support/fakes';
import type { FakeDeviceConnection, FakePty } from './support/fakes';
import type { ClaudeCaller } from '../src/application/ports/claude-cli';
import type { OpenSessionRequest } from '../src/application/services/session-launcher';
import type { ClaudeRun } from '../src/domain/ask/route';
import type { ClientMessage } from '../src/domain/phone/protocol';
import type { Project } from '../src/domain/project/project';
import type { AskedQuestions } from '../src/domain/questions/question';
import type { SessionRow } from '../src/domain/session/session';

/**
 * What a phone sees and does once it is in: the running list, a terminal's
 * replay and stream, input and resizes going through ownership, answering
 * questions, and starting a session through Ask Patch. Driven with decoded
 * protocol messages through fake connections, and checked on what the phones
 * were sent and what reached the PTYs.
 */

const APP = '/code/app';
const SITE = '/code/site';
const PHONE = { id: 'phone-1', name: 'Pixel 9' };
const OTHER_PHONE = { id: 'phone-2', name: 'Pixel 7' };

type Pty = FakePty & { readonly resizes: [number, number][] };

function row(sessionId: string, fields: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId,
    summary: `First prompt of ${sessionId}`,
    firstPrompt: '',
    projectPath: APP,
    created: '2026-10-01T10:00:00.000Z',
    modified: '2026-10-01T10:00:00.000Z',
    messageCount: 3,
    name: null,
    starred: 0,
    archived: 0,
    ...fields,
  };
}

/** A `claude` for the routing call that answers when the test says so. */
function fakeCaller() {
  const calls: { signal: AbortSignal; finish(run: ClaudeRun): void }[] = [];
  const cli: ClaudeCaller = {
    call(_args, signal) {
      return new Promise((resolve) => { calls.push({ signal, finish: resolve }); });
    },
    warm() { throw new Error('not warmed in these tests'); },
  };
  return { cli, calls };
}

/** The CLI's JSON envelope around Haiku's answer. */
function answered(answer: Record<string, unknown>): ClaudeRun {
  return { exitCode: 0, stdout: JSON.stringify({ type: 'result', result: JSON.stringify(answer) }), stderr: '' };
}

function harness() {
  const registry = new SessionRegistry();
  const renderer = fakeRenderer();
  const timers = fakeTimers();
  const routeTimers = fakeTimers();
  const caller = fakeCaller();
  const ptys = new Map<string, Pty>();
  const launches: OpenSessionRequest[] = [];
  const archived: string[] = [];
  let archiveResult: { ok: boolean; error?: string } = { ok: true };
  let projects: Project[] = [
    { projectPath: APP, folder: '-code-app', sessions: [] },
    { projectPath: SITE, folder: '-code-site', sessions: [] },
    { projectPath: 'ssh://me@host/srv', folder: 'srv', sessions: [], remote: true },
  ];
  let ids = 0;
  /** What the voice service was handed, as [call, connection id, message type]. */
  const voiceCalls: [string, string, string?][] = [];

  const addSession = (id: string, fields: { projectPath?: string; openedAt?: number; plain?: boolean } = {}): Pty => {
    const pty = resizingPty();
    registry.add(id, new ActiveSession({
      pty,
      projectPath: fields.projectPath ?? APP,
      projectFolder: '-code-app',
      knownTranscriptIds: new Set(),
      sessionSlug: null,
      isPlainTerminal: fields.plain ?? false,
      remote: null,
      openedAt: fields.openedAt ?? 0,
    }));
    ptys.set(id, pty);
    return pty;
  };

  let service: PhoneSessionsService;
  // The wiring tees the gateway into the phone service; the questions do it here.
  const questionRenderer = {
    ...renderer,
    questionsAsked: (pending: Parameters<typeof renderer.questionsAsked>[0]) => {
      renderer.questionsAsked(pending);
      service.questionsAsked(pending);
    },
    questionsSettled: (settled: Parameters<typeof renderer.questionsSettled>[0]) => {
      renderer.questionsSettled(settled);
      service.questionsSettled(settled);
    },
  };
  const questions = new QuestionService({
    registry,
    renderer: questionRenderer,
    endpoint: { url: 'http://127.0.0.1:4000', token: 't' },
    prompter: { send() {}, onExit: () => ({ dispose() {} }) },
    clock: { now: () => 5_000 },
    log: silentLog,
  });

  service = new PhoneSessionsService({
    registry,
    running: { runningSessionIds: () => registry.snapshot().filter(([, s]) => !s.exited).map(([id]) => id) },
    projects: { list: () => projects },
    questions,
    router: () => new AskRouteService({ cli: caller.cli, timers: routeTimers, log: silentLog, call: ASK_PATCH_CALL }),
    launcher: {
      async open(request) {
        launches.push(request);
        addSession(request.sessionId, { projectPath: request.projectPath });
        return { ok: true, reattached: false };
      },
    },
    archiver: {
      archive(sessionId) {
        archived.push(sessionId);
        return archiveResult;
      },
    },
    settings: { effective: () => ({ permissionMode: 'auto', worktree: true }) },
    renderer,
    voice: {
      connected(connection) { voiceCalls.push(['connected', connection.id]); },
      message(connection, message) { voiceCalls.push(['message', connection.id, message.type]); },
      disconnected(connection) { voiceCalls.push(['disconnected', connection.id]); },
    },
    ids: { newId: () => `new-${++ids}` },
    clock: { now: () => 9_000 },
    timers,
    log: silentLog,
  });

  const connect = (device = PHONE, connectionId = `conn-${device.id}`): FakeDeviceConnection => {
    const connection = fakeDeviceConnection(connectionId, device.id);
    service.connected(connection, device);
    return connection;
  };
  const send = (connection: FakeDeviceConnection, message: ClientMessage) => service.message(connection, message);
  const ask = (hookToolUseId = 'tu-1'): AskedQuestions => ({
    toolUseId: hookToolUseId,
    questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
    toolInput: {},
  });

  return {
    service, registry, renderer, timers, caller, ptys, launches, archived, questions, addSession, connect, send, ask, voiceCalls,
    setProjects: (next: Project[]) => { projects = next; },
    failArchive: (error: string) => { archiveResult = { ok: false, error }; },
  };
}

/** Let the awaited routing call and launch run on. */
const settle = () => new Promise(resolve => setImmediate(resolve));

// ── The list ──

test('a phone that connects is sent the running sessions and the questions', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  h.setProjects([{ projectPath: APP, folder: '-code-app', sessions: [row('s1', { aiTitle: 'Fix login' }), row('old')] }]);

  /* When */
  const phone = h.connect();

  /* Then */
  assert.deepEqual(phone.sent, [
    {
      type: 'sessions',
      sessions: [{
        id: 's1', name: 'Fix login', project: 'app', projectPath: APP, remote: null,
        state: 'idle', waiting: null, owner: { kind: 'mac' }, changedAt: 0,
      }],
    },
    { type: 'questions', pending: [] },
  ]);
});

test('the list is in the sidebar order: needing you, then idle by recency, then working by start', () => {
  /* Given */
  const h = harness();
  for (const id of ['busy-old', 'busy-new', 'idle-old', 'idle-new', 'asking']) h.addSession(id);
  h.setProjects([{
    projectPath: APP, folder: '-code-app', sessions: [
      row('busy-old', { created: '2026-10-01T08:00:00.000Z', modified: '2026-10-01T12:00:00.000Z' }),
      row('busy-new', { created: '2026-10-01T09:00:00.000Z', modified: '2026-10-01T09:30:00.000Z' }),
      row('idle-old', { modified: '2026-10-01T10:00:00.000Z' }),
      row('idle-new', { modified: '2026-10-01T11:00:00.000Z' }),
      row('asking', { modified: '2026-09-01T10:00:00.000Z' }),
    ],
  }]);
  const phone = h.connect();
  phone.clear();

  /* When */
  h.service.cliBusyState('busy-old', true);
  h.service.cliBusyState('busy-new', true);
  h.service.sessionNeedsAttention('asking');
  h.timers.tick();

  /* Then */
  const [list] = phone.of('sessions');
  assert.deepEqual(list.sessions.map(s => [s.id, s.state]), [
    ['asking', 'needs-you'], ['idle-new', 'idle'], ['idle-old', 'idle'], ['busy-new', 'busy'], ['busy-old', 'busy'],
  ]);
  assert.equal(list.sessions[0].waiting, 'terminal');
  assert.equal(list.sessions[0].changedAt, 9_000);
});

test('changes close together go out as one list', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const phone = h.connect();
  phone.clear();

  /* When */
  h.service.cliBusyState('s1', true);
  h.service.cliBusyState('s1', false);
  h.service.sessionsChanged();
  h.timers.tick();

  /* Then */
  assert.equal(phone.of('sessions').length, 1);
});

test('a session waiting on questions needs you, and the phones get the questions', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const phone = h.connect();
  phone.clear();

  /* When */
  h.questions.receive('s1', h.ask(), () => {});
  h.timers.tick();

  /* Then */
  assert.equal(phone.of('questions')[0].pending[0].toolUseId, 'tu-1');
  const [list] = phone.of('sessions');
  assert.deepEqual([list.sessions[0].state, list.sessions[0].waiting], ['needs-you', 'questions']);
});

test('a session with no row yet, and a turn starting, clear what it showed', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const phone = h.connect();
  h.service.sessionNeedsAttention('s1');
  phone.clear();

  /* When */
  h.service.cliBusyState('s1', true);
  h.timers.tick();

  /* Then */
  const [list] = phone.of('sessions');
  assert.deepEqual([list.sessions[0].name, list.sessions[0].state, list.sessions[0].waiting], ['New session', 'busy', null]);
});

test('a re-key moves the row and the stream, and an exit is told once under the new id', () => {
  /* Given */
  const h = harness();
  h.addSession('old');
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 'old', cols: 40, rows: 20 });
  phone.clear();

  /* When */
  h.registry.rekey('old', 'new');
  h.service.sessionForked('old', 'new');
  h.service.terminalData('new', 'after');
  h.service.processExited('new', 0);
  h.service.processExited('old', 0);

  /* Then */
  assert.deepEqual(phone.of('session-rekeyed'), [{ type: 'session-rekeyed', from: 'old', to: 'new' }]);
  assert.deepEqual(phone.frames, [['new', 'after']]);
  assert.deepEqual(phone.of('exited'), [{ type: 'exited', sessionId: 'new', exitCode: 0 }]);
});

// ── Archiving ──

test('archive archives the session under its current id and answers the phone under the id it sent', () => {
  /* Given */
  const h = harness();
  h.addSession('old');
  const phone = h.connect();
  h.registry.rekey('old', 'new');
  h.service.sessionForked('old', 'new');
  phone.clear();

  /* When */
  h.send(phone, { type: 'archive', sessionId: 'old' });

  /* Then */
  assert.deepEqual(h.archived, ['new']);
  assert.deepEqual(phone.of('archive-result'), [{ type: 'archive-result', sessionId: 'old', ok: true }]);
});

test('a session that has already exited can still be archived', () => {
  /* Given */
  const h = harness();
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'archive', sessionId: 'gone' });

  /* Then */
  assert.deepEqual(h.archived, ['gone']);
  assert.deepEqual(phone.of('archive-result'), [{ type: 'archive-result', sessionId: 'gone', ok: true }]);
});

test('an archive that fails tells the phone why', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  h.failArchive('Could not stop it');
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'archive', sessionId: 's1' });

  /* Then */
  assert.deepEqual(phone.of('archive-result'), [{ type: 'archive-result', sessionId: 's1', ok: false, error: 'Could not stop it' }]);
});

test('a session archived elsewhere is pushed to every phone, under the id it is running under now', () => {
  /* Given */
  const h = harness();
  h.addSession('old');
  const phone = h.connect();
  const other = h.connect(OTHER_PHONE);
  h.registry.rekey('old', 'new');
  h.service.sessionForked('old', 'new');
  phone.clear();
  other.clear();

  /* When */
  h.service.sessionArchived('old');

  /* Then */
  assert.deepEqual(phone.of('archived'), [{ type: 'archived', sessionId: 'new' }]);
  assert.deepEqual(other.of('archived'), [{ type: 'archived', sessionId: 'new' }]);
});

test('a session that has already exited is pushed as archived under the id it had', () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  phone.clear();

  /* When */
  h.service.sessionArchived('gone');

  /* Then */
  assert.deepEqual(phone.of('archived'), [{ type: 'archived', sessionId: 'gone' }]);
});

// ── The terminal ──

test('attach sends attached, replays the buffer, then streams; a second phone gets its own replay', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const session = h.registry.get('s1')!;
  session.output.append('hello ');
  session.altScreen = true;
  const phone = h.connect();
  const other = h.connect(OTHER_PHONE);

  /* When */
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  h.service.terminalData('s1', 'live');
  h.send(other, { type: 'attach', sessionId: 's1', cols: 50, rows: 25 });
  h.service.terminalData('s1', 'more');

  /* Then */
  assert.deepEqual(phone.of('attached'), [{ type: 'attached', sessionId: 's1', owner: { kind: 'mac' } }]);
  assert.deepEqual(phone.frames, [['s1', ENTER_ALT_SCREEN], ['s1', 'hello '], ['s1', HIDE_CURSOR], ['s1', 'live'], ['s1', 'more']]);
  assert.deepEqual(other.frames, [['s1', ENTER_ALT_SCREEN], ['s1', 'hello '], ['s1', HIDE_CURSOR], ['s1', 'more']]);
});

test('detach stops the stream', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  phone.clear();

  /* When */
  h.send(phone, { type: 'detach', sessionId: 's1' });
  h.service.terminalData('s1', 'unseen');

  /* Then */
  assert.deepEqual(phone.frames, []);
});

test('input and sizes from a phone that is not active never reach the PTY', () => {
  /* Given */
  const h = harness();
  const pty = h.addSession('s1');
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });

  /* When */
  h.send(phone, { type: 'input', sessionId: 's1', data: 'ls\r' });
  h.send(phone, { type: 'size', sessionId: 's1', cols: 42, rows: 22 });

  /* Then */
  assert.deepEqual(pty.writes, []);
  assert.deepEqual(pty.resizes, []);
  assert.equal(h.service.macInputAllowed('s1'), true);
});

test('use here makes the phone active: the PTY takes its last size, nudged, and everyone is told', () => {
  /* Given */
  const h = harness();
  const pty = h.addSession('s1');
  const phone = h.connect();
  const other = h.connect(OTHER_PHONE);
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  h.send(phone, { type: 'size', sessionId: 's1', cols: 42, rows: 22 });

  /* When */
  h.send(phone, { type: 'use-here', sessionId: 's1' });
  h.timers.tick();
  h.timers.tick();

  /* Then */
  assert.deepEqual(pty.resizes, [[42, 22], [43, 22], [42, 22]]);
  const owner = { kind: 'device', deviceId: 'phone-1', name: 'Pixel 9' };
  assert.deepEqual(other.of('owner'), [{ type: 'owner', sessionId: 's1', owner }]);
  assert.deepEqual(phone.of('owner'), [{ type: 'owner', sessionId: 's1', owner }]);
  assert.deepEqual(h.renderer.only('terminalOwnerChanged'), [['terminalOwnerChanged', 's1', owner]]);
  assert.deepEqual(h.service.owners(), { s1: owner });
});

test('the active phone types and resizes; the Mac does neither', () => {
  /* Given */
  const h = harness();
  const pty = h.addSession('s1');
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  h.send(phone, { type: 'use-here', sessionId: 's1' });
  h.timers.tick();
  h.timers.tick();
  pty.resizes.length = 0;

  /* When */
  h.send(phone, { type: 'input', sessionId: 's1', data: 'yes\r' });
  h.send(phone, { type: 'size', sessionId: 's1', cols: 41, rows: 20 });
  const macTakes = h.service.macResized('s1', 120, 40);

  /* Then */
  assert.deepEqual(pty.writes, ['yes\r']);
  assert.deepEqual(pty.resizes, [[41, 20]]);
  assert.equal(macTakes, false);
  assert.equal(h.service.macInputAllowed('s1'), false);
});

test('a phone that disconnects keeps the session until use here on the Mac, which takes the Mac’s size', () => {
  /* Given */
  const h = harness();
  const pty = h.addSession('s1');
  h.service.macResized('s1', 120, 40);
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  h.send(phone, { type: 'use-here', sessionId: 's1' });
  h.timers.tick();
  h.timers.tick();
  pty.resizes.length = 0;

  /* When */
  h.service.disconnected(phone);
  const ownerAfterDrop = h.service.owners().s1;
  const result = h.service.useHereOnMac('s1');
  h.timers.tick();
  h.timers.tick();

  /* Then */
  assert.deepEqual(ownerAfterDrop, { kind: 'device', deviceId: 'phone-1', name: 'Pixel 9' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(h.service.owners().s1, { kind: 'mac' });
  assert.deepEqual(pty.resizes, [[120, 40], [121, 40], [120, 40]]);
  assert.equal(h.service.macResized('s1', 100, 30), true);
});

test('use here on the Mac with its size resizes at once', () => {
  /* Given */
  const h = harness();
  const pty = h.addSession('s1');
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  h.send(phone, { type: 'use-here', sessionId: 's1' });
  pty.resizes.length = 0;

  /* When */
  h.service.useHereOnMac('s1', 110, 35);

  /* Then */
  assert.deepEqual(pty.resizes, [[110, 35]]);
});

test('use here on the Mac for a session that is not running says so', () => {
  /* Given */
  const h = harness();

  /* When */
  const result = h.service.useHereOnMac('gone');

  /* Then */
  assert.equal(result.ok, false);
});

test('a removed device gives its sessions back to the Mac', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  h.service.macResized('s1', 120, 40);
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  h.send(phone, { type: 'use-here', sessionId: 's1' });
  h.service.disconnected(phone);
  const other = h.connect(OTHER_PHONE);

  /* When */
  h.service.deviceRemoved('phone-1');

  /* Then */
  assert.deepEqual(other.of('owner'), [{ type: 'owner', sessionId: 's1', owner: { kind: 'mac' } }]);
  assert.equal(h.service.macInputAllowed('s1'), true);
});

test('a plain terminal resized from the phone keeps the redraw out of its buffer and gets no nudge', () => {
  /* Given */
  const h = harness();
  const pty = h.addSession('t1', { plain: true });
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 't1', cols: 40, rows: 20 });

  /* When */
  h.send(phone, { type: 'use-here', sessionId: 't1' });
  const suppressed = h.registry.get('t1')!.output.suppressed;
  h.timers.tick();

  /* Then */
  assert.equal(suppressed, true);
  assert.equal(h.registry.get('t1')!.output.suppressed, false);
  assert.deepEqual(pty.resizes, [[40, 20]]);
});

// ── Questions ──

test('answering on the phone answers, settles as the phone’s, and makes the phone active', () => {
  /* Given */
  const h = harness();
  const pty = h.addSession('s1');
  let replied = 0;
  h.questions.receive('s1', h.ask(), () => { replied++; });
  const phone = h.connect();
  const other = h.connect(OTHER_PHONE);
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });

  /* When */
  h.send(phone, { type: 'answer', sessionId: 's1', toolUseId: 'tu-1', answers: { 'Which store?': 'A' } });

  /* Then */
  assert.equal(replied, 1);
  assert.deepEqual(phone.of('answer-result'), [{ type: 'answer-result', sessionId: 's1', toolUseId: 'tu-1', ok: true }]);
  assert.deepEqual(other.of('questions-settled'), [
    { type: 'questions-settled', sessionId: 's1', toolUseId: 'tu-1', outcome: 'answered', answeredOn: 'phone' },
  ]);
  assert.deepEqual(h.renderer.only('questionsSettled')[0][1], { sessionId: 's1', toolUseId: 'tu-1', outcome: 'answered', answeredOn: 'phone' });
  assert.deepEqual(h.service.owners().s1, { kind: 'device', deviceId: 'phone-1', name: 'Pixel 9' });
  assert.deepEqual(pty.resizes[0], [40, 20]);
});

test('the first answer wins: a second from another phone is told the questions are gone', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  h.questions.receive('s1', h.ask(), () => {});
  const phone = h.connect();
  const other = h.connect(OTHER_PHONE);
  h.send(phone, { type: 'answer', sessionId: 's1', toolUseId: 'tu-1', answers: { 'Which store?': 'A' } });

  /* When */
  h.send(other, { type: 'answer', sessionId: 's1', toolUseId: 'tu-1', answers: { 'Which store?': 'B' } });

  /* Then */
  const [result] = other.of('answer-result');
  assert.equal(result.ok, false);
  assert.deepEqual(h.service.owners().s1, { kind: 'device', deviceId: 'phone-1', name: 'Pixel 9' });
});

test('answering on the Mac makes the Mac active again', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const phone = h.connect();
  h.send(phone, { type: 'attach', sessionId: 's1', cols: 40, rows: 20 });
  h.send(phone, { type: 'use-here', sessionId: 's1' });
  h.questions.receive('s1', h.ask(), () => {});
  phone.clear();

  /* When */
  h.questions.answer('s1', 'tu-1', { 'Which store?': 'A' });

  /* Then */
  assert.deepEqual(phone.of('questions-settled')[0].answeredOn, 'mac');
  assert.deepEqual(phone.of('owner'), [{ type: 'owner', sessionId: 's1', owner: { kind: 'mac' } }]);
});

test('a withdrawn set settles on the phones with nowhere it was answered, and moves nothing', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');
  const handle = h.questions.receive('s1', h.ask(), () => {});
  const phone = h.connect();

  /* When */
  handle.withdraw();

  /* Then */
  assert.deepEqual(phone.of('questions-settled'), [
    { type: 'questions-settled', sessionId: 's1', toolUseId: 'tu-1', outcome: 'withdrawn', answeredOn: null },
  ]);
  assert.deepEqual(phone.of('questions').at(-1), { type: 'questions', pending: [] });
  assert.deepEqual(h.service.owners(), {});
});

// ── Ask Patch ──

test('a confident answer starts the session with the default options, owned by the phone at its size', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'ask', requestId: 'r1', text: 'fix the app', cols: 40, rows: 20 });
  h.caller.calls[0].finish(answered({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the app.' }));
  await settle();

  /* Then */
  assert.deepEqual(h.launches, [{
    sessionId: 'new-1', projectPath: APP, isNew: true,
    options: { permissionMode: 'auto', worktree: true, initialPrompt: 'Fix the app.' },
  }]);
  assert.deepEqual(phone.of('ask-result'), [
    { type: 'ask-result', requestId: 'r1', result: { kind: 'confident', sessionId: 'new-1', project: 'app' } },
  ]);
  const owner = { kind: 'device', deviceId: 'phone-1', name: 'Pixel 9' };
  assert.deepEqual(h.renderer.only('terminalOwnerChanged'), [['terminalOwnerChanged', 'new-1', owner]]);
  assert.deepEqual(h.ptys.get('new-1')!.resizes[0], [40, 20]);
  assert.equal(h.service.macInputAllowed('new-1'), false);
});

test('an unsure answer offers the candidates with their latest session title, and the prompt', async () => {
  /* Given */
  const h = harness();
  h.setProjects([
    { projectPath: APP, folder: '-code-app', sessions: [row('a1', { aiTitle: 'Login bug', modified: '2026-10-02T00:00:00.000Z' }), row('a0', { aiTitle: 'Older' })] },
    { projectPath: SITE, folder: '-code-site', sessions: [] },
  ]);
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'ask', requestId: 'r1', text: 'fix it' });
  h.caller.calls[0].finish(answered({ projectPath: null, confident: false, candidates: [APP, SITE], prompt: 'Fix it.' }));
  await settle();

  /* Then */
  assert.deepEqual(phone.of('ask-result'), [{
    type: 'ask-result', requestId: 'r1', result: {
      kind: 'unsure', prompt: 'Fix it.', candidates: [
        { path: APP, folder: 'app', recentTitle: 'Login bug' },
        { path: SITE, folder: 'site', recentTitle: null },
      ],
    },
  }]);
  assert.deepEqual(h.launches, []);
});

test('no match and a failed call answer with Patch’s line', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'ask', requestId: 'r1', text: 'something' });
  h.caller.calls[0].finish(answered({ projectPath: null, confident: false, candidates: [], prompt: '' }));
  await settle();
  h.send(phone, { type: 'ask', requestId: 'r2', text: 'again' });
  h.caller.calls[1].finish({ exitCode: 1, stdout: '', stderr: 'boom' });
  await settle();

  /* Then */
  const [noMatch, failed] = phone.of('ask-result').map(message => message.result.kind);
  assert.deepEqual([noMatch, failed], ['noMatch', 'failed']);
});

test('ask-cancel kills the call and answers cancelled', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  h.send(phone, { type: 'ask', requestId: 'r1', text: 'fix the app' });

  /* When */
  h.send(phone, { type: 'ask-cancel', requestId: 'r1' });
  await settle();

  /* Then */
  assert.equal(h.caller.calls[0].signal.aborted, true);
  assert.deepEqual(phone.of('ask-result'), [{ type: 'ask-result', requestId: 'r1', result: { kind: 'cancelled' } }]);
});

test('a phone disconnecting kills its call, and nothing starts', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  h.send(phone, { type: 'ask', requestId: 'r1', text: 'fix the app' });

  /* When */
  h.service.disconnected(phone);
  h.caller.calls[0].finish(answered({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix.' }));
  await settle();

  /* Then */
  assert.equal(h.caller.calls[0].signal.aborted, true);
  assert.deepEqual(h.launches, []);
  assert.deepEqual(phone.of('ask-result'), []);
});

test('two phones asking at once never cancel each other', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  const other = h.connect(OTHER_PHONE);

  /* When */
  h.send(phone, { type: 'ask', requestId: 'r1', text: 'one' });
  h.send(other, { type: 'ask', requestId: 'r2', text: 'two' });

  /* Then */
  assert.deepEqual(h.caller.calls.map(call => call.signal.aborted), [false, false]);
});

test('ask-start starts in the picked project with the prompt, owned by the phone', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'ask-start', requestId: 'r1', projectPath: SITE, prompt: 'Tidy the CSS', cols: 40, rows: 20 });
  await settle();

  /* Then */
  assert.deepEqual(h.launches.map(l => [l.projectPath, l.options?.initialPrompt]), [[SITE, 'Tidy the CSS']]);
  assert.deepEqual(phone.of('ask-started'), [{ type: 'ask-started', requestId: 'r1', sessionId: 'new-1' }]);
  assert.equal(h.service.owners()['new-1'].kind, 'device');
});

test('ask-start refuses a project Ask Patch would not offer', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'ask-start', requestId: 'r1', projectPath: 'ssh://me@host/srv', prompt: 'hi' });
  await settle();

  /* Then */
  assert.equal(phone.of('ask-error').length, 1);
  assert.deepEqual(h.launches, []);
});

test('list-projects answers the local projects with how many sessions run in each', () => {
  /* Given */
  const h = harness();
  h.addSession('s1', { projectPath: APP });
  h.addSession('s2', { projectPath: APP });
  h.setProjects([
    { projectPath: APP, folder: '-code-app', sessions: [] },
    { projectPath: `${APP}/.claude/worktrees/feature`, folder: 'wt', sessions: [] },
    { projectPath: 'ssh://me@host/srv', folder: 'srv', sessions: [], remote: true },
  ]);
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'list-projects' });

  /* Then */
  assert.deepEqual(phone.of('projects'), [{ type: 'projects', projects: [{ path: APP, folder: 'app', running: 2 }] }]);
});

test('nothing is pushed while no phone is connected', () => {
  /* Given */
  const h = harness();
  h.addSession('s1');

  /* When */
  h.service.cliBusyState('s1', true);

  /* Then */
  assert.equal(h.timers.pending, 0);
});

// ── Voice ──

test('a phone is handed to the voice service on welcome, with its voice messages, and when it goes', () => {
  /* Given */
  const h = harness();
  const phone = h.connect();

  /* When */
  h.send(phone, { type: 'voice-start', voiceId: 'v1', sessionId: 's1' });
  h.send(phone, { type: 'voice-chunk', voiceId: 'v1', seq: 0, audio: 'AAAA' });
  h.send(phone, { type: 'voice-end', voiceId: 'v1' });
  h.send(phone, { type: 'voice-cancel', voiceId: 'v1' });
  h.service.disconnected(phone);

  /* Then */
  assert.deepEqual(h.voiceCalls, [
    ['connected', phone.id],
    ['message', phone.id, 'voice-start'],
    ['message', phone.id, 'voice-chunk'],
    ['message', phone.id, 'voice-end'],
    ['message', phone.id, 'voice-cancel'],
    ['disconnected', phone.id],
  ]);
});

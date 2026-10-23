import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VoiceService } from '../src/application/services/voice-service';
import { CLEANUP_TIMEOUT_MS } from '../src/domain/voice/cleanup';
import { GAP_REASON } from '../src/domain/voice/recording';
import { wavFile } from '../src/domain/voice/wav';
import { fakeDeviceConnection, fakeTimers, silentLog } from './support/fakes';
import type { FakeDeviceConnection } from './support/fakes';
import type { ClaudeCaller } from '../src/application/ports/claude-cli';
import type { Transcriber, VoiceModelStore } from '../src/application/ports/voice';
import type { VoiceMessage } from '../src/application/services/voice-service';
import type { ClaudeRun } from '../src/domain/ask/route';
import type { Project } from '../src/domain/project/project';

/**
 * Hold-to-talk on the Mac: a recording from start to result, the rules about
 * which recording counts, and Whisper's model being fetched on first use.
 * Whisper, the model store and `claude` are fakes that answer when the test
 * says so; checked on what the phones were sent.
 */

const MODEL = '/data/voice/ggml-large-v3-turbo.bin';
const PROJECTS: Project[] = [
  { projectPath: '/code/app', folder: '-code-app', sessions: [] },
  { projectPath: '/code/site', folder: '-code-site', sessions: [] },
  { projectPath: '/code/app/.claude/worktrees/x', folder: '-x', sessions: [] },
];

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  let whisperInstalled = true;
  let speaking = true;
  let modelPresent = true;
  let whisperPrints: string | Error = ' um so fix the login\n';
  const transcriptions: { wav: Uint8Array; modelPath: string; prompt: string; signal: AbortSignal }[] = [];
  const transcriber: Transcriber = {
    available: async () => whisperInstalled,
    async transcribe(request, signal) {
      transcriptions.push({ ...request, signal });
      if (whisperPrints instanceof Error) throw whisperPrints;
      return whisperPrints;
    },
  };

  const downloads: { progress(value: number | null): void; done: ReturnType<typeof deferred<void>> }[] = [];
  const model: VoiceModelStore = {
    path: MODEL,
    present: async () => modelPresent,
    download(onProgress) {
      const done = deferred<void>();
      downloads.push({ progress: onProgress, done });
      return done.promise;
    },
  };

  /** 'answer' answers at once with the cleaned text; 'hang' waits for the test. */
  let cleanup: { kind: 'answer'; text: string } | { kind: 'fail' } | { kind: 'hang' } = { kind: 'answer', text: 'So fix the login.' };
  const calls: { args: readonly string[]; signal: AbortSignal; finish(run: ClaudeRun): void }[] = [];
  const cli: ClaudeCaller = {
    call(args, signal) {
      return new Promise((resolve) => {
        calls.push({ args, signal, finish: resolve });
        if (cleanup.kind === 'answer') resolve({ exitCode: 0, stdout: JSON.stringify({ type: 'result', result: cleanup.text }), stderr: '' });
        if (cleanup.kind === 'fail') resolve({ exitCode: 1, stdout: '', stderr: 'boom' });
      });
    },
    warm() { throw new Error('not warmed'); },
  };

  const timers = fakeTimers();
  const service = new VoiceService({
    transcriber, model, cli, timers, log: silentLog,
    // The chunks here are a few bytes, not speech; `hasSpeech` has its own tests.
    heard: () => speaking,
    registry: { find: (id) => (id === 's1' ? { key: 's1', session: { projectPath: '/code/site' } } as never : null) },
    projects: { list: () => PROJECTS },
  });

  const connect = (id = 'conn-1'): FakeDeviceConnection => {
    const connection = fakeDeviceConnection(id, `device-${id}`);
    service.connected(connection);
    return connection;
  };
  const send = (connection: FakeDeviceConnection, message: VoiceMessage) => service.message(connection, message);
  /** A recording of these chunks, let go of. */
  const record = (connection: FakeDeviceConnection, voiceId: string, chunks: Uint8Array[], sessionId?: string) => {
    send(connection, { type: 'voice-start', voiceId, ...(sessionId ? { sessionId } : {}) });
    chunks.forEach((pcm, seq) => send(connection, { type: 'voice-chunk', voiceId, seq, audio: Buffer.from(pcm).toString('base64') }));
    send(connection, { type: 'voice-end', voiceId });
  };

  return {
    service, timers, transcriptions, downloads, calls, connect, send, record,
    setWhisperInstalled: (value: boolean) => { whisperInstalled = value; },
    setModelPresent: (value: boolean) => { modelPresent = value; },
    setWhisperPrints: (value: string | Error) => { whisperPrints = value; },
    setCleanup: (value: typeof cleanup) => { cleanup = value; },
    setSpeaking: (value: boolean) => { speaking = value; },
  };
}

/** Let the awaited checks, Whisper and the cleanup run on. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

const pcm = (...values: number[]) => Uint8Array.from(values);

// ── Welcome ──

test('a phone is told the voice status on welcome; a model not yet fetched still counts as ready', async () => {
  /* Given */
  const h = harness();
  h.setModelPresent(false);

  /* When */
  const phone = h.connect();
  await settle();

  /* Then */
  assert.deepEqual(phone.sent, [{ type: 'voice-status', status: { kind: 'ready' } }]);
  assert.equal(h.downloads.length, 0);
});

test('a Mac without whisper-cli says so after welcome', async () => {
  /* Given */
  const h = harness();
  h.setWhisperInstalled(false);

  /* When */
  const phone = h.connect();
  await settle();

  /* Then */
  assert.deepEqual(phone.of('voice-status').map(message => message.status), [{ kind: 'ready' }, { kind: 'no-whisper' }]);
});

// ── A recording ──

test('a recording is transcribed by Whisper, cleaned up by Haiku, and sent back as text', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  await settle();
  phone.clear();

  /* When */
  h.record(phone, 'v1', [pcm(1, 2), pcm(3, 4)], 's1');
  await settle();

  /* Then */
  assert.deepEqual(phone.sent, [{ type: 'voice-result', voiceId: 'v1', result: { kind: 'text', text: 'So fix the login.' } }]);
  assert.equal(h.transcriptions.length, 1);
  assert.deepEqual(h.transcriptions[0].wav, wavFile(pcm(1, 2, 3, 4)));
  assert.equal(h.transcriptions[0].modelPath, MODEL);
  assert.equal(h.transcriptions[0].prompt, 'Claude, Switchboard, Patch, site, app');
  const prompt = h.calls[0].args.at(-1)!;
  assert.ok(prompt.includes('Vocabulary: Claude, Switchboard, Patch, site, app'));
  assert.ok(prompt.includes('<transcript>\num so fix the login\n</transcript>'));
});

test('a cleanup that fails leaves the raw transcript', async () => {
  /* Given */
  const h = harness();
  h.setCleanup({ kind: 'fail' });
  const phone = h.connect();

  /* When */
  h.record(phone, 'v1', [pcm(1, 2)]);
  await settle();

  /* Then */
  assert.deepEqual(phone.of('voice-result'), [{ type: 'voice-result', voiceId: 'v1', result: { kind: 'text', text: 'um so fix the login' } }]);
});

test('a cleanup that takes too long is killed, and the raw transcript goes out', async () => {
  /* Given */
  const h = harness();
  h.setCleanup({ kind: 'hang' });
  const phone = h.connect();
  h.record(phone, 'v1', [pcm(1, 2)]);
  await settle();
  assert.equal(phone.of('voice-result').length, 0);

  /* When */
  h.timers.tick();
  await settle();

  /* Then */
  assert.equal(CLEANUP_TIMEOUT_MS, 15_000);
  assert.equal(h.calls[0].signal.aborted, true);
  assert.deepEqual(phone.of('voice-result'), [{ type: 'voice-result', voiceId: 'v1', result: { kind: 'text', text: 'um so fix the login' } }]);
});

test('silence comes back empty, with or without asking Whisper', async () => {
  /* Given */
  const h = harness();
  h.setWhisperPrints(' [BLANK_AUDIO]\n');
  const phone = h.connect();

  /* When */
  h.record(phone, 'v1', [pcm(0, 0)]);
  h.record(phone, 'v2', []);
  await settle();

  /* Then */
  const results = phone.of('voice-result').map(message => [message.voiceId, message.result]);
  assert.deepEqual(results.sort(), [['v1', { kind: 'empty' }], ['v2', { kind: 'empty' }]]);
  assert.equal(h.transcriptions.length, 1);
  assert.equal(h.calls.length, 0);
});

test('a recording with a chunk missing fails without being transcribed', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  h.send(phone, { type: 'voice-start', voiceId: 'v1' });
  h.send(phone, { type: 'voice-chunk', voiceId: 'v1', seq: 0, audio: 'AQI=' });

  /* When */
  h.send(phone, { type: 'voice-chunk', voiceId: 'v1', seq: 2, audio: 'AQI=' });
  h.send(phone, { type: 'voice-end', voiceId: 'v1' });
  await settle();

  /* Then */
  assert.deepEqual(phone.of('voice-result'), [{ type: 'voice-result', voiceId: 'v1', result: { kind: 'failed', reason: GAP_REASON } }]);
  assert.equal(h.transcriptions.length, 0);
});

test('a Whisper that fails answers failed, with its reason', async () => {
  /* Given */
  const h = harness();
  h.setWhisperPrints(new Error('failed to load model'));
  const phone = h.connect();

  /* When */
  h.record(phone, 'v1', [pcm(1, 2)]);
  await settle();

  /* Then */
  assert.deepEqual(phone.of('voice-result'), [
    { type: 'voice-result', voiceId: 'v1', result: { kind: 'failed', reason: 'Whisper couldn’t transcribe that: failed to load model' } },
  ]);
});

test('a cancelled recording is dropped and nothing is sent', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  await settle();
  phone.clear();
  h.send(phone, { type: 'voice-start', voiceId: 'v1' });
  h.send(phone, { type: 'voice-chunk', voiceId: 'v1', seq: 0, audio: 'AQI=' });

  /* When */
  h.send(phone, { type: 'voice-cancel', voiceId: 'v1' });
  h.send(phone, { type: 'voice-end', voiceId: 'v1' });
  await settle();

  /* Then */
  assert.deepEqual(phone.sent, []);
  assert.equal(h.transcriptions.length, 0);
});

test('a new recording drops the one being received; its chunks and end are ignored', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect();
  h.send(phone, { type: 'voice-start', voiceId: 'v1' });
  h.send(phone, { type: 'voice-chunk', voiceId: 'v1', seq: 0, audio: 'AQI=' });

  /* When */
  h.send(phone, { type: 'voice-start', voiceId: 'v2' });
  h.send(phone, { type: 'voice-chunk', voiceId: 'v1', seq: 1, audio: 'AQI=' });
  h.send(phone, { type: 'voice-chunk', voiceId: 'v2', seq: 0, audio: 'AwQ=' });
  h.send(phone, { type: 'voice-end', voiceId: 'v1' });
  h.send(phone, { type: 'voice-end', voiceId: 'v2' });
  await settle();

  /* Then */
  assert.deepEqual(phone.of('voice-result').map(message => message.voiceId), ['v2']);
  assert.deepEqual(h.transcriptions.map(t => t.wav), [wavFile(pcm(3, 4))]);
});

test('each phone has its own recording', async () => {
  /* Given */
  const h = harness();
  const one = h.connect('conn-1');
  const two = h.connect('conn-2');

  /* When */
  h.send(one, { type: 'voice-start', voiceId: 'a' });
  h.send(two, { type: 'voice-start', voiceId: 'b' });
  h.send(one, { type: 'voice-chunk', voiceId: 'a', seq: 0, audio: 'AQI=' });
  h.send(two, { type: 'voice-chunk', voiceId: 'b', seq: 0, audio: 'AwQ=' });
  h.send(one, { type: 'voice-end', voiceId: 'a' });
  h.send(two, { type: 'voice-end', voiceId: 'b' });
  await settle();

  /* Then */
  assert.deepEqual(one.of('voice-result').map(message => message.voiceId), ['a']);
  assert.deepEqual(two.of('voice-result').map(message => message.voiceId), ['b']);
});

test('a phone that disconnects loses its recording, and what was being transcribed for it is stopped', async () => {
  /* Given */
  const h = harness();
  h.setCleanup({ kind: 'hang' });
  const phone = h.connect();
  h.record(phone, 'v1', [pcm(1, 2)]);
  h.send(phone, { type: 'voice-start', voiceId: 'v2' });
  h.send(phone, { type: 'voice-chunk', voiceId: 'v2', seq: 0, audio: 'AQI=' });
  await settle();

  /* When */
  h.service.disconnected(phone);
  h.send(phone, { type: 'voice-end', voiceId: 'v2' });
  await settle();

  /* Then */
  assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.transcriptions.length, 1);
  assert.equal(phone.of('voice-result').length, 0);
});

// ── Whisper and its model ──

test('without whisper-cli a recording is answered unavailable at once, and every phone hears the status', async () => {
  /* Given */
  const h = harness();
  const phone = h.connect('conn-1');
  const other = h.connect('conn-2');
  await settle();
  phone.clear();
  other.clear();
  h.setWhisperInstalled(false);

  /* When */
  h.send(phone, { type: 'voice-start', voiceId: 'v1' });
  await settle();
  h.send(phone, { type: 'voice-chunk', voiceId: 'v1', seq: 0, audio: 'AQI=' });
  h.send(phone, { type: 'voice-end', voiceId: 'v1' });
  await settle();

  /* Then */
  assert.deepEqual(phone.sent, [
    { type: 'voice-status', status: { kind: 'no-whisper' } },
    { type: 'voice-result', voiceId: 'v1', result: { kind: 'unavailable', status: { kind: 'no-whisper' } } },
  ]);
  assert.deepEqual(other.sent, [{ type: 'voice-status', status: { kind: 'no-whisper' } }]);
  assert.equal(h.transcriptions.length, 0);
});

test('whisper-cli installed while the app runs is found on the next recording', async () => {
  /* Given */
  const h = harness();
  h.setWhisperInstalled(false);
  const phone = h.connect();
  await settle();
  phone.clear();
  h.setWhisperInstalled(true);

  /* When */
  h.record(phone, 'v1', [pcm(1, 2)]);
  await settle();

  /* Then */
  assert.deepEqual(phone.sent, [
    { type: 'voice-status', status: { kind: 'ready' } },
    { type: 'voice-result', voiceId: 'v1', result: { kind: 'text', text: 'So fix the login.' } },
  ]);
});

test('the first recording without a model starts the download, and the phones follow it in whole percents', async () => {
  /* Given */
  const h = harness();
  h.setModelPresent(false);
  const phone = h.connect('conn-1');
  const other = h.connect('conn-2');
  await settle();
  phone.clear();
  other.clear();

  /* When */
  h.record(phone, 'v1', [pcm(1, 2)]);
  await settle();
  const download = h.downloads[0];
  download.progress(0);
  download.progress(0.371);
  download.progress(0.375);
  download.progress(0.38);

  /* Then */
  assert.equal(h.downloads.length, 1);
  assert.equal(h.transcriptions.length, 0);
  assert.deepEqual(phone.of('voice-result'), [
    { type: 'voice-result', voiceId: 'v1', result: { kind: 'unavailable', status: { kind: 'preparing', progress: null } } },
  ]);
  assert.deepEqual(other.of('voice-status').map(message => message.status), [
    { kind: 'preparing', progress: null },
    { kind: 'preparing', progress: 0 },
    { kind: 'preparing', progress: 0.37 },
    { kind: 'preparing', progress: 0.38 },
  ]);

  /* When */
  h.send(phone, { type: 'voice-start', voiceId: 'v2' });
  await settle();

  /* Then */
  assert.equal(h.downloads.length, 1);
  assert.deepEqual(phone.of('voice-result').at(-1), {
    type: 'voice-result', voiceId: 'v2', result: { kind: 'unavailable', status: { kind: 'preparing', progress: 0.38 } },
  });

  /* When */
  h.setModelPresent(true);
  download.done.resolve();
  await settle();
  h.record(phone, 'v3', [pcm(1, 2)]);
  await settle();

  /* Then */
  assert.deepEqual(other.of('voice-status').at(-1), { type: 'voice-status', status: { kind: 'ready' } });
  assert.deepEqual(phone.of('voice-result').at(-1), { type: 'voice-result', voiceId: 'v3', result: { kind: 'text', text: 'So fix the login.' } });
});

test('a failed download is reported, and the next recording tries again', async () => {
  /* Given */
  const h = harness();
  h.setModelPresent(false);
  const phone = h.connect();
  h.send(phone, { type: 'voice-start', voiceId: 'v1' });
  await settle();

  /* When */
  h.downloads[0].done.reject(new Error('the download answered 503'));
  await settle();

  /* Then */
  assert.deepEqual(phone.of('voice-status').at(-1), {
    type: 'voice-status', status: { kind: 'prepare-failed', reason: 'The speech model couldn’t be downloaded: the download answered 503' },
  });

  /* When */
  h.send(phone, { type: 'voice-start', voiceId: 'v2' });
  await settle();

  /* Then */
  assert.equal(h.downloads.length, 2);
  assert.deepEqual(phone.of('voice-status').at(-1), { type: 'voice-status', status: { kind: 'preparing', progress: null } });
  assert.deepEqual(phone.of('voice-result').at(-1), {
    type: 'voice-result', voiceId: 'v2', result: { kind: 'unavailable', status: { kind: 'preparing', progress: null } },
  });
});

test('a recording with no speech in it is empty, and Whisper never hears it', async () => {
  /* Given */
  const h = harness();
  h.setSpeaking(false);
  const phone = h.connect();

  /* When */
  h.record(phone, 'v1', [pcm(0, 0, 0, 0)]);
  await settle();

  /* Then */
  assert.deepEqual(phone.of('voice-result').map(message => message.result), [{ kind: 'empty' }]);
  assert.equal(h.transcriptions.length, 0);
  assert.equal(h.calls.length, 0);
});

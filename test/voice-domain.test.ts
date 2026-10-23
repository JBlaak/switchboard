import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLEANUP_SYSTEM_PROMPT, cleanupArgs, keepsToTranscript, readCleanupRun } from '../src/domain/voice/cleanup';
import { MAX_RECORDING_BYTES, Recording } from '../src/domain/voice/recording';
import { FIXED_VOCABULARY, MAX_VOCABULARY, voiceVocabulary } from '../src/domain/voice/vocabulary';
import { hasSpeech } from '../src/domain/voice/speech';
import { wavFile } from '../src/domain/voice/wav';
import { readTranscript, whisperArgs, whisperCandidates, whisperFailure, whisperPrompt } from '../src/domain/voice/whisper';
import { routeBootArgs } from '../src/domain/ask/route';

/**
 * The pure parts of hold-to-talk: buffering the phone's PCM, the WAV around
 * it, the vocabulary, Whisper's command line and output, and the cleanup call.
 */

const bytes = (...values: number[]) => Uint8Array.from(values);

// ── The recording ──

test('chunks in order are kept in order', () => {
  /* Given */
  const recording = new Recording('v1', null);

  /* When */
  recording.add(0, bytes(1, 2));
  recording.add(1, bytes(3, 4, 5, 6));

  /* Then */
  assert.equal(recording.broken, false);
  assert.deepEqual(recording.pcm(), bytes(1, 2, 3, 4, 5, 6));
});

test('a chunk out of turn breaks the recording, and nothing after it is kept', () => {
  /* Given */
  const recording = new Recording('v1', null);
  recording.add(0, bytes(1, 2));

  /* When */
  recording.add(2, bytes(3, 4));
  recording.add(1, bytes(5, 6));

  /* Then */
  assert.equal(recording.broken, true);
  assert.deepEqual(recording.pcm(), bytes());
});

test('a recording that does not start at 0 is broken', () => {
  /* Given */
  const recording = new Recording('v1', null);

  /* When */
  recording.add(1, bytes(1, 2));

  /* Then */
  assert.equal(recording.broken, true);
});

test('audio past ten minutes is dropped, and what came before is kept', () => {
  /* Given */
  const recording = new Recording('v1', null);
  recording.add(0, new Uint8Array(MAX_RECORDING_BYTES - 2));

  /* When */
  recording.add(1, bytes(7, 8, 9, 10));
  recording.add(2, bytes(11, 12));

  /* Then */
  const pcm = recording.pcm();
  assert.equal(recording.broken, false);
  assert.equal(pcm.length, MAX_RECORDING_BYTES);
  assert.deepEqual(pcm.subarray(-2), bytes(7, 8));
});

test('a stray odd byte at the end is left out, so the PCM is whole samples', () => {
  /* Given */
  const recording = new Recording('v1', 's1');

  /* When */
  recording.add(0, bytes(1, 2, 3));

  /* Then */
  assert.deepEqual(recording.pcm(), bytes(1, 2));
  assert.equal(recording.sessionId, 's1');
});

// ── The WAV ──

test('the WAV has the 44-byte PCM header for 16 kHz mono 16-bit, then the samples', () => {
  /* Given */
  const pcm = bytes(1, 2, 3, 4);

  /* When */
  const wav = wavFile(pcm);

  /* Then */
  const view = new DataView(wav.buffer);
  const text = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  assert.equal(wav.length, 48);
  assert.equal(text(0), 'RIFF');
  assert.equal(view.getUint32(4, true), 40);
  assert.equal(text(8), 'WAVE');
  assert.equal(text(12), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36), 'data');
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual(wav.subarray(44), pcm);
});

// ── The vocabulary ──

test('the vocabulary is the fixed words, the session’s project, then the other projects, without repeats', () => {
  /* Given */
  const projects = ['site', 'switchboard', 'app', 'Site'];

  /* When */
  const words = voiceVocabulary('app', projects);

  /* Then */
  assert.deepEqual(words, ['Claude', 'Switchboard', 'Patch', 'app', 'site']);
});

test('a long project list is cut, never the session’s project', () => {
  /* Given */
  const projects = Array.from({ length: 100 }, (_, i) => `project-${i}`);

  /* When */
  const words = voiceVocabulary('mine', projects);

  /* Then */
  assert.equal(words.length, MAX_VOCABULARY);
  assert.deepEqual(words.slice(0, FIXED_VOCABULARY.length + 1), [...FIXED_VOCABULARY, 'mine']);
});

// ── Whisper ──

test('whisper-cli is looked for in Homebrew’s directories first, then on PATH', () => {
  /* Given */
  const pathEnv = '/usr/bin:/usr/local/bin:/Users/me/bin/';

  /* When */
  const candidates = whisperCandidates(pathEnv);

  /* Then */
  assert.deepEqual(candidates, [
    '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/usr/bin/whisper-cli', '/Users/me/bin/whisper-cli',
  ]);
});

test('whisper runs without timestamps or prints, detecting the language, primed with the vocabulary', () => {
  /* Given */
  const prompt = whisperPrompt(['Claude', 'switchboard']);

  /* When */
  const args = whisperArgs({ model: '/m/model.bin', wav: '/t/a.wav', prompt });

  /* Then */
  assert.deepEqual(args, ['-m', '/m/model.bin', '-f', '/t/a.wav', '-l', 'auto', '-nt', '-np', '--prompt', 'Claude, switchboard']);
});

test('the transcript is Whisper’s lines joined, without its markers for silence and noise', () => {
  /* Given */
  const cases: [string, string][] = [
    [' Fix the login.\n And add a test.\n', 'Fix the login. And add a test.'],
    [' [BLANK_AUDIO]\n', ''],
    ['[ Silence ]\n (music)\n *coughs*\n', ''],
    [' Doe dit [BLANK_AUDIO] nu.\n', 'Doe dit nu.'],
    ['', ''],
  ];

  /* When */
  const read = cases.map(([stdout]) => readTranscript(stdout));

  /* Then */
  assert.deepEqual(read, cases.map(([, expected]) => expected));
});

test('a Whisper failure is its error line, not the usage text that follows it', () => {
  /* Given */
  const stderr = "error: model file not found '/m.bin'\n\nusage: whisper-cli [options] file0 file1 ...\n  -h, --help\n";

  /* When */
  const reasons = [whisperFailure(stderr, 'Command failed'), whisperFailure('', 'Command failed')];

  /* Then */
  assert.deepEqual(reasons, ["model file not found '/m.bin'", 'Command failed']);
});

// ── The cleanup ──

test('the cleanup runs Haiku with Ask Patch’s startup flags, its own system prompt, and the transcript last', () => {
  /* Given */
  const transcript = '--help me fix the login';

  /* When */
  const args = cleanupArgs(transcript, ['Claude', 'app']);

  /* Then */
  const boot = routeBootArgs();
  assert.deepEqual(args.slice(0, -3), boot.slice(0, -2));
  assert.deepEqual(args.slice(-3, -1), ['--system-prompt', CLEANUP_SYSTEM_PROMPT]);
  const prompt = args.at(-1)!;
  assert.ok(prompt.startsWith('Vocabulary: Claude, app\n'));
  assert.ok(prompt.includes('<transcript>\n--help me fix the login\n</transcript>'));
});

test('the cleaned text is the envelope’s result; a failure or an empty answer is null', () => {
  /* Given */
  const envelope = (fields: Record<string, unknown>) => `hello from .zshrc\n${JSON.stringify({ type: 'result', ...fields })}\n`;
  const runs = [
    { exitCode: 0, stdout: envelope({ result: '  Fix the login.  ' }), stderr: '' },
    { exitCode: 0, stdout: envelope({ result: '<transcript>\nFix it.\n</transcript>' }), stderr: '' },
    { exitCode: 1, stdout: envelope({ result: 'You’ve hit your limit', is_error: true }), stderr: '' },
    { exitCode: 0, stdout: envelope({ result: '   ' }), stderr: '' },
    { exitCode: 0, stdout: 'garbage', stderr: '' },
    { exitCode: null, stdout: '', stderr: '' },
  ];

  /* When */
  const read = runs.map(readCleanupRun);

  /* Then */
  assert.deepEqual(read, ['Fix the login.', 'Fix it.', null, null, null, null]);
});

test('a cleanup longer than the transcript is not used', () => {
  /* Given */
  const transcript = 'um so what does uh this function do';
  const tidied = 'What does this function do?';
  const answered = 'This function parses the invite and returns null when any part is malformed.';

  /* When */
  const kept = [keepsToTranscript(transcript, tidied), keepsToTranscript(transcript, answered)];

  /* Then */
  assert.deepEqual(kept, [true, false]);
});

// ── Speech or silence ──

/** `ms` of a 200 Hz tone at `amplitude`, as 16 kHz PCM16. */
function tone(ms: number, amplitude: number): Uint8Array {
  const samples = ms * 16;
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, Math.round(amplitude * Math.sin((2 * Math.PI * 200 * i) / 16_000)), true);
  return out;
}

test('silence and room noise are not speech', () => {
  /* Given */
  const silence = new Uint8Array(32_000);
  const roomNoise = tone(2_000, 30);

  /* When */
  const heard = [hasSpeech(silence), hasSpeech(roomNoise)];

  /* Then */
  assert.deepEqual(heard, [false, false]);
});

test('a voice at speaking level is speech', () => {
  /* Given */
  const quiet = new Uint8Array(32_000);
  const voice = tone(500, 6_000);
  const recording = new Uint8Array(quiet.length + voice.length);
  recording.set(quiet);
  recording.set(voice, quiet.length);

  /* When */
  const heard = hasSpeech(recording);

  /* Then */
  assert.equal(heard, true);
});

/** `parts` one after the other. */
function joined(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

test('a quiet voice over a quiet room is speech', () => {
  /* Given: the phone's raw mic has no gain, so speech at screen distance is near −50 dBFS over a room near −64 */
  const room = tone(1_000, 30);
  const voice = tone(1_500, 150);

  /* When */
  const heard = hasSpeech(joined(room, voice, room));

  /* Then */
  assert.equal(heard, true);
});

test('a quiet room after the mic warms up is not speech', () => {
  /* Given: some mics hand over digital silence before the room comes in */
  const warmUp = new Uint8Array(16_000);
  const room = tone(2_000, 30);

  /* When */
  const heard = hasSpeech(joined(warmUp, room));

  /* Then */
  assert.equal(heard, false);
});

test('a short bump over a quiet room is not speech', () => {
  /* Given */
  const room = tone(1_000, 30);
  const bump = tone(90, 3_000);

  /* When */
  const heard = hasSpeech(joined(room, bump, room));

  /* Then */
  assert.equal(heard, false);
});

test('a single click is not speech', () => {
  /* Given */
  const click = tone(30, 20_000);
  const recording = new Uint8Array(32_000);
  recording.set(click, 10_000);

  /* When */
  const heard = hasSpeech(recording);

  /* Then */
  assert.equal(heard, false);
});

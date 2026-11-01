import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript } from '../src/domain/session/transcript';

const IDENTITY = { sessionId: 's1', folder: 'f1', projectPath: '/p' };
const TIMES = { birthtime: '2026-01-01T00:00:00.000Z', mtime: '2026-01-09T00:00:00.000Z' };

function user(text: string, entrypoint?: string): string {
  return JSON.stringify({
    type: 'user', timestamp: '2026-01-02T00:00:00.000Z', entrypoint, message: { role: 'user', content: text },
  });
}

function assistant(entrypoint?: string): string {
  return JSON.stringify({
    type: 'assistant', timestamp: '2026-01-02T00:00:01.000Z', entrypoint,
    message: { role: 'assistant', content: [{ text: 'ok' }] },
  });
}

const parse = (lines: string[]) => parseTranscript(lines, IDENTITY, TIMES);

test('a session started at a terminal is listed', () => {
  /* When */
  const session = parse([user('Fix the build', 'cli'), assistant('cli')]);

  /* Then */
  assert.ok(session);
});

test('a session a tool started with claude -p is not listed', () => {
  /* When */
  const session = parse([user('Answer this question the user typed', 'sdk-cli'), assistant('sdk-cli')]);

  /* Then */
  assert.equal(session, null);
});

test('a scheduled run is listed: its seeded first turn names no entrypoint', () => {
  /* When */
  const session = parse([
    user('Scheduled Task: tidy the inbox'),
    user('Run the scheduled task', 'sdk-cli'),
    assistant('sdk-cli'),
  ]);

  /* Then */
  assert.ok(session);
});

test('a headless session resumed at a terminal is listed, as a conversation after all', () => {
  /* When */
  const session = parse([
    user('Assess the release risk', 'sdk-cli'),
    assistant('sdk-cli'),
    user('Why that score?', 'cli'),
  ]);

  /* Then */
  assert.ok(session);
});

test('a transcript that names no entrypoint is listed', () => {
  /* When */
  const session = parse([user('New project')]);

  /* Then */
  assert.ok(session);
});

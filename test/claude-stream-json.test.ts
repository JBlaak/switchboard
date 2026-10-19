import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endedRun, finishedRun, streamJsonArgs, userMessageLine } from '../src/infrastructure/claude-cli/stream-json';
import { readRouteRun } from '../src/domain/ask/route';
import type { RouteRequest } from '../src/domain/ask/model';

/**
 * A warm `claude` in stream-json (S2): what it is started with, what it is
 * sent, and how its events become the run a cold call would have printed.
 */

const APP = '/code/app';
const request: RouteRequest = {
  text: 'Fix the login bug in app',
  candidates: [{ projectPath: APP, folder: '-code-app', recentTitles: [] }],
};
const ANSWER = JSON.stringify({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' });

/** What the CLI printed for one message, trimmed: init, the turn, then the result. */
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-4-5' });
const ASSISTANT = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] } });
const RESULT = { type: 'result', subtype: 'success', is_error: false, duration_ms: 768, num_turns: 1, result: ANSWER };

test('streamJsonArgs boots the process to read its message from stdin', () => {
  /* Given */
  const boot = ['-p', '--model', 'haiku'];

  /* When */
  const args = streamJsonArgs(boot);

  /* Then */
  assert.deepEqual(args, ['-p', '--model', 'haiku', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
});

test('streamJsonArgs swaps the cold call\'s output format for stream-json', () => {
  /* Given */
  const boot = ['-p', '--output-format', 'json', '--tools', ''];

  /* When */
  const args = streamJsonArgs(boot);

  /* Then */
  assert.deepEqual(args, ['-p', '--tools', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
});

test('userMessageLine is one line holding the prompt as a user message', () => {
  /* Given */
  const prompt = 'Projects:\n- path: /code/app\n\nRequest:\n"quoted" text';

  /* When */
  const line = userMessageLine(prompt);

  /* Then */
  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false);
  assert.deepEqual(JSON.parse(line), { type: 'user', message: { role: 'user', content: prompt } });
});

test('the result event becomes a run that reads like a cold call\'s', () => {
  /* Given */
  const stdout = [INIT, ASSISTANT, JSON.stringify(RESULT)].join('\n') + '\n';

  /* When */
  const run = finishedRun(stdout, '');

  /* Then */
  assert.deepEqual(run, { exitCode: 0, stdout: JSON.stringify(RESULT) + '\n', stderr: '' });
  assert.deepEqual(readRouteRun(run!, request), { kind: 'confident', projectPath: APP, prompt: 'Fix the login bug.' });
});

test('there is no run until the result line is complete', () => {
  /* Given */
  const partial = INIT + '\n' + JSON.stringify(RESULT).slice(0, 40);

  /* When */
  const run = finishedRun(partial, '');

  /* Then */
  assert.equal(run, null);
});

test('an error result exits 1, as the cold call does', () => {
  /* Given */
  const error = { ...RESULT, is_error: true, result: 'API Error: 529 Overloaded' };

  /* When */
  const run = finishedRun(INIT + '\n' + JSON.stringify(error) + '\n', '');

  /* Then */
  assert.equal(run?.exitCode, 1);
  assert.deepEqual(readRouteRun(run!, request), { kind: 'failed', reason: 'Claude couldn’t answer: API Error: 529 Overloaded' });
});

test('a process that ended without a result keeps what it said and drops its events', () => {
  /* Given */
  const stdout = INIT + '\nInvalid API key · Please run /login\n';

  /* When */
  const run = endedRun(stdout, 1, '');

  /* Then */
  assert.deepEqual(run, { exitCode: 1, stdout: 'Invalid API key · Please run /login', stderr: '' });
  assert.deepEqual(readRouteRun(run, request), { kind: 'failed', reason: 'Claude couldn’t answer: Invalid API key · Please run /login' });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUICK_ROUTE_SYSTEM_PROMPT, quickRouteArgs, quickRouteBootArgs, quickRoutePrompt, readQuickRouteRun,
} from '../src/domain/ask/quick-route';
import { GARBLED_LINE, NO_MATCH_LINE, readRouteRun, routeArgs, routePrompt } from '../src/domain/ask/route';
import type { RouteRequest } from '../src/domain/ask/model';

/**
 * Quick Ask's routing call (#142, C1): Ask Patch's call, which can also answer
 * that the request is a task or something to save.
 */

const APP = '/code/app';
const SITE = '/code/site';

function request(text = 'create a task to call Peter'): RouteRequest {
  return {
    text,
    candidates: [APP, SITE].map(projectPath => ({ projectPath, folder: projectPath.replace(/\//g, '-'), recentTitles: [] })),
  };
}

function envelope(answer: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: typeof answer === 'string' ? answer : JSON.stringify(answer),
    ...extra,
  });
}

function run(answer: unknown): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: envelope(answer) + '\n', stderr: '' };
}

const NO_ROUTE = { projectPath: null, confident: false, candidates: [], prompt: '' };

// ── The call ──

test('quickRouteArgs are the boot args plus the message', () => {
  /* Given */
  const req = request();

  /* When */
  const args = quickRouteArgs(req);

  /* Then */
  assert.deepEqual(args, [...quickRouteBootArgs(), quickRoutePrompt(req)]);
  assert.equal(quickRoutePrompt(req), routePrompt(req));
});

test('the boot args are routeArgs\' flags, with the quick instructions', () => {
  /* Given */
  const routeFlags = routeArgs(request()).slice(0, -1);

  /* When */
  const boot = quickRouteBootArgs();

  /* Then */
  assert.equal(boot.length, routeFlags.length);
  const prompt = boot.indexOf('--system-prompt');
  assert.deepEqual(boot.filter((_, i) => i !== prompt + 1), routeFlags.filter((_, i) => i !== prompt + 1));
  assert.equal(boot[prompt + 1], QUICK_ROUTE_SYSTEM_PROMPT);
  assert.ok(!boot.includes('--json-schema'));
});

test('the quick instructions keep the routing rules and answer in one shape with kind and captureText', () => {
  /* Given */
  const text = QUICK_ROUTE_SYSTEM_PROMPT;

  /* When */
  const answering = text.match(/Answering:/g) ?? [];

  /* Then */
  assert.equal(answering.length, 1);
  assert.match(text, /Choosing the project:/);
  assert.match(text, /"kind": "session" or "task" or "save"/);
  assert.match(text, /"captureText"/);
  assert.match(text, /When in doubt, answer "session"/);
  assert.match(text, /remind me to/);
  assert.match(text, /bookmark/);
});

// ── The answer ──

test('"create a task to call Peter" is a task capture of "call Peter"', () => {
  /* Given */
  const answer = { kind: 'task', captureText: 'call Peter', ...NO_ROUTE };

  /* When */
  const result = readQuickRouteRun(run(answer), request());

  /* Then */
  assert.deepEqual(result, { kind: 'capture', target: 'tasks', text: 'call Peter' });
});

test('a save is a capture for James, also inside a code fence', () => {
  /* Given */
  const answer = '```json\n' + JSON.stringify({ kind: 'save', captureText: 'https://example.com/glass', ...NO_ROUTE }) + '\n```';

  /* When */
  const result = readQuickRouteRun(run(answer), request('https://example.com/glass'));

  /* Then */
  assert.deepEqual(result, { kind: 'capture', target: 'james', text: 'https://example.com/glass' });
});

test('a session answer reads exactly as Ask Patch reads it', () => {
  /* Given */
  const routing = { projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' };
  const req = request('fix the login bug in app');

  /* When */
  const result = readQuickRouteRun(run({ kind: 'session', captureText: '', ...routing }), req);

  /* Then */
  assert.deepEqual(result, readRouteRun(run(routing), req));
  assert.deepEqual(result, { kind: 'confident', projectPath: APP, prompt: 'Fix the login bug.' });
});

test('a kind it doesn\'t know falls back to the session reading', () => {
  /* Given */
  const routing = { projectPath: null, confident: false, candidates: [APP, SITE], prompt: 'Look at it.' };

  /* When */
  const result = readQuickRouteRun(run({ kind: 'maybe-task', captureText: 'call Peter', ...routing }), request());

  /* Then */
  assert.deepEqual(result, { kind: 'unsure', candidates: [APP, SITE], prompt: 'Look at it.' });
});

test('a task with no text to capture falls back to the session reading', () => {
  /* Given */
  const answer = { kind: 'task', captureText: '   ', ...NO_ROUTE };

  /* When */
  const result = readQuickRouteRun(run(answer), request());

  /* Then */
  assert.deepEqual(result, { kind: 'noMatch', reason: NO_MATCH_LINE });
});

test('an answer without kind reads as a plain routing answer', () => {
  /* Given */
  const routing = { projectPath: SITE, confident: true, candidates: [SITE], prompt: 'Update the footer.' };

  /* When */
  const result = readQuickRouteRun(run(routing), request());

  /* Then */
  assert.deepEqual(result, { kind: 'confident', projectPath: SITE, prompt: 'Update the footer.' });
});

test('prose instead of JSON is garbled', () => {
  /* Given */
  const answer = 'Sure! I will create that task.';

  /* When */
  const result = readQuickRouteRun(run(answer), request());

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: GARBLED_LINE });
});

test('a session answer with keys of its own is garbled, as in Ask Patch', () => {
  /* Given */
  const answer = { kind: 'session', captureText: '', ...NO_ROUTE, projectPath: APP, extra: 1 };

  /* When */
  const result = readQuickRouteRun(run(answer), request());

  /* Then */
  assert.deepEqual(result, { kind: 'failed', reason: GARBLED_LINE });
});

test('a failed call reads exactly as Ask Patch reads it', () => {
  /* Given */
  const failed = { exitCode: 1, stdout: envelope('You\'ve hit your limit · resets 3pm', { is_error: true }) + '\n', stderr: '' };

  /* When */
  const result = readQuickRouteRun(failed, request());

  /* Then */
  assert.deepEqual(result, readRouteRun(failed, request()));
  assert.equal(result.kind, 'failed');
});

test('a run with no envelope reads exactly as Ask Patch reads it', () => {
  /* Given */
  const crashed = { exitCode: 127, stdout: '', stderr: 'claude: command not found' };

  /* When */
  const result = readQuickRouteRun(crashed, request());

  /* Then */
  assert.deepEqual(result, readRouteRun(crashed, request()));
});

test('the message lists every project\'s skills, and each project\'s own under it', () => {
  /* Given */
  const req: RouteRequest = { ...request('grill me on the upload flow'), skills: { everywhere: ['grill-me', 'tdd'], byProject: { [APP]: ['release'] } } };

  /* When */
  const prompt = quickRoutePrompt(req);

  /* Then */
  assert.equal(prompt, [
    'Projects:',
    `- path: ${APP}`,
    '  folder: app',
    '  skills: release',
    `- path: ${SITE}`,
    '  folder: site',
    '',
    'Skills in every project:',
    'grill-me, tdd',
    '',
    'Request:',
    'grill me on the upload flow',
  ].join('\n'));
});

test('with no skills, the message is Ask Patch\'s', () => {
  /* Given */
  const req: RouteRequest = { ...request(), skills: { everywhere: [], byProject: {} } };

  /* When */
  const prompt = quickRoutePrompt(req);

  /* Then */
  assert.equal(prompt, routePrompt(request()));
});

test('the instructions keep a named skill as its slash command', () => {
  /* Given */
  const instructions = QUICK_ROUTE_SYSTEM_PROMPT;

  /* When */
  const skills = instructions.slice(instructions.indexOf('Skills:'), instructions.indexOf('Answering:'));

  /* Then */
  assert.match(skills, /Never reword them/);
  assert.match(skills, /prompt is "\/" and the skill's name exactly as listed/);
});

test('no project still keeps a prompt that starts on a skill every project has', () => {
  /* Given */
  const req: RouteRequest = { ...request('Grill me'), skills: { everywhere: ['grill-me'], byProject: {} } };
  const answer = { kind: 'session', captureText: '', projectPath: null, confident: false, candidates: [], prompt: '/grill-me' };

  /* When */
  const result = readQuickRouteRun(run(answer), req);

  /* Then */
  assert.deepEqual(result, { kind: 'noMatch', reason: NO_MATCH_LINE, prompt: '/grill-me' });
});

test('no project drops a prompt that starts on a skill that isn\'t listed', () => {
  /* Given */
  const req: RouteRequest = { ...request('Grill me'), skills: { everywhere: ['tdd'], byProject: { [APP]: ['grill-me'] } } };
  const answer = { kind: 'session', captureText: '', projectPath: null, confident: false, candidates: [], prompt: '/grill-me' };

  /* When */
  const result = readQuickRouteRun(run(answer), req);

  /* Then */
  assert.deepEqual(result, { kind: 'noMatch', reason: NO_MATCH_LINE });
});

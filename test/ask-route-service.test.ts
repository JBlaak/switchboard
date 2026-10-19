import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_ROUTE_TIMEOUT_MS, AskRouteService, TIMEOUT_LINE } from '../src/application/services/ask-route-service';
import { NO_MATCH_LINE } from '../src/domain/ask/route';
import { fakeTimers, silentLog } from './support/fakes';
import type { ClaudeCaller } from '../src/application/ports/claude-cli';
import type { RouteRequest } from '../src/domain/ask/model';
import type { ClaudeRun } from '../src/domain/ask/route';

/**
 * One routing call at a time, and every way it can end answered: a result,
 * a cancel, a newer request, a timeout, a failing CLI.
 */

const APP = '/code/app';

const request: RouteRequest = {
  text: 'Fix the login bug in app',
  candidates: [{ projectPath: APP, folder: '-code-app', recentTitles: [] }],
};

interface PendingCall {
  args: readonly string[];
  signal: AbortSignal;
  finish(run: ClaudeRun): void;
  fail(err: Error): void;
}

/** A `claude` that answers when the test says so, and records being aborted. */
function fakeCaller() {
  const calls: PendingCall[] = [];
  const cli: ClaudeCaller = {
    call(args, signal) {
      return new Promise((resolve, reject) => {
        calls.push({ args, signal, finish: resolve, fail: reject });
      });
    },
  };
  return { cli, calls };
}

function harness() {
  const { cli, calls } = fakeCaller();
  const timers = fakeTimers();
  const warnings: string[] = [];
  const log = { ...silentLog, warn: (...parts: unknown[]) => { warnings.push(parts.join(' ')); } };
  const service = new AskRouteService({ cli, timers, log });
  return { service, calls, timers, warnings };
}

function success(answer: unknown): ClaudeRun {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(answer) }),
    stderr: '',
  };
}

test('a routing call answers with what Haiku picked', async () => {
  /* Given */
  const { service, calls, timers } = harness();
  const pending = service.route(request);

  /* When */
  calls[0].finish(success({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' }));
  const result = await pending;

  /* Then */
  assert.equal(calls[0].args[0], '-p');
  assert.equal(calls[0].args.at(-1)?.endsWith('Request:\nFix the login bug in app'), true);
  assert.deepEqual(result, {
    kind: 'confident',
    projectPath: APP,
    prompt: 'Fix the login bug.',
  });
  assert.equal(timers.pending, 0);
});

test('no listed project answers no match', async () => {
  /* Given */
  const { service, calls } = harness();
  const pending = service.route(request);

  /* When */
  calls[0].finish(success({ projectPath: null, confident: false, candidates: [], prompt: 'Fix it.' }));

  /* Then */
  assert.deepEqual(await pending, { kind: 'noMatch', reason: NO_MATCH_LINE });
});

test('cancel kills the call and answers cancelled', async () => {
  /* Given */
  const { service, calls, timers } = harness();
  const pending = service.route(request);

  /* When */
  service.cancel();

  /* Then */
  assert.deepEqual(await pending, { kind: 'cancelled' });
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(timers.pending, 0);
});

test('a call that ends after being cancelled changes nothing', async () => {
  /* Given */
  const { service, calls } = harness();
  const pending = service.route(request);
  service.cancel();

  /* When */
  calls[0].finish({ exitCode: 143, stdout: '', stderr: '' });

  /* Then */
  assert.deepEqual(await pending, { kind: 'cancelled' });
});

test('cancel with nothing in flight does nothing', () => {
  /* Given */
  const { service, calls } = harness();

  /* When */
  service.cancel();

  /* Then */
  assert.equal(calls.length, 0);
});

test('a new request cancels the one still in flight', async () => {
  /* Given */
  const { service, calls } = harness();
  const first = service.route(request);

  /* When */
  const second = service.route({ ...request, text: 'Fix the logout bug in app' });
  calls[1].finish(success({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the logout bug.' }));

  /* Then */
  assert.deepEqual(await first, { kind: 'cancelled' });
  assert.equal(calls[0].signal.aborted, true);
  assert.equal((await second).kind, 'confident');
});

test('cancel stops the newest request, and the one it replaced stays cancelled', async () => {
  /* Given */
  const { service, calls } = harness();
  const first = service.route(request);
  const second = service.route(request);

  /* When */
  service.cancel();

  /* Then */
  assert.deepEqual(await first, { kind: 'cancelled' });
  assert.deepEqual(await second, { kind: 'cancelled' });
  assert.equal(calls.length, 2);
});

test('a call that takes longer than 30 s fails and is killed', async () => {
  /* Given */
  const { service, calls, timers, warnings } = harness();
  const pending = service.route(request);

  /* When */
  timers.tick();

  /* Then */
  assert.equal(ASK_ROUTE_TIMEOUT_MS, 30_000);
  assert.deepEqual(await pending, { kind: 'failed', reason: TIMEOUT_LINE });
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(warnings.length, 1);
});

test('a non-zero exit fails with a reason', async () => {
  /* Given */
  const { service, calls } = harness();
  const pending = service.route(request);

  /* When */
  calls[0].finish({ exitCode: 127, stdout: '', stderr: 'zsh: command not found: claude' });

  /* Then */
  assert.deepEqual(await pending, { kind: 'failed', reason: 'Claude couldn’t answer: zsh: command not found: claude' });
});

test('an is_error result fails with the CLI\'s message', async () => {
  /* Given */
  const { service, calls } = harness();
  const pending = service.route(request);

  /* When */
  calls[0].finish({
    exitCode: 1,
    stdout: JSON.stringify({ type: 'result', is_error: true, result: 'API Error: 529 Overloaded' }),
    stderr: '',
  });

  /* Then */
  assert.deepEqual(await pending, { kind: 'failed', reason: 'Claude couldn’t answer: API Error: 529 Overloaded' });
});

test('the usage limit says so, with when it resets', async () => {
  /* Given */
  const { service, calls } = harness();
  const pending = service.route(request);

  /* When */
  calls[0].finish({
    exitCode: 1,
    stdout: JSON.stringify({ type: 'result', is_error: true, result: 'You\'ve hit your limit · resets 3pm (Europe/Amsterdam)' }),
    stderr: '',
  });

  /* Then */
  assert.deepEqual(await pending, { kind: 'failed', reason: 'You’ve hit your usage limit — resets 3pm (Europe/Amsterdam).' });
});

test('a claude that cannot be started fails rather than rejecting', async () => {
  /* Given */
  const { service, calls } = harness();
  const pending = service.route(request);

  /* When */
  calls[0].fail(new Error('spawn /bin/zsh ENOENT'));

  /* Then */
  assert.deepEqual(await pending, { kind: 'failed', reason: 'Couldn’t run claude: spawn /bin/zsh ENOENT' });
});

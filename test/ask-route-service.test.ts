import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_ROUTE_TIMEOUT_MS, AskRouteService, TIMEOUT_LINE } from '../src/application/services/ask-route-service';
import { NO_MATCH_LINE, routeBootArgs, routePrompt } from '../src/domain/ask/route';
import { WARM_IDLE_MS } from '../src/application/ports/claude-cli';
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

interface WarmedCall {
  bootArgs: readonly string[];
  /** One per send; the prompt is in `args[0]`. */
  sends: PendingCall[];
}

/** A `claude` that answers when the test says so, and records being aborted. */
function fakeCaller() {
  const calls: PendingCall[] = [];
  const warmed: WarmedCall[] = [];
  const cli: ClaudeCaller = {
    call(args, signal) {
      return new Promise((resolve, reject) => {
        calls.push({ args, signal, finish: resolve, fail: reject });
      });
    },
    warm(bootArgs) {
      const warm: WarmedCall = { bootArgs, sends: [] };
      warmed.push(warm);
      return {
        send(prompt, signal) {
          return new Promise((resolve, reject) => {
            warm.sends.push({ args: [prompt], signal, finish: resolve, fail: reject });
          });
        },
      };
    },
  };
  return { cli, calls, warmed };
}

function harness() {
  const { cli, calls, warmed } = fakeCaller();
  const timers = fakeTimers();
  const warnings: string[] = [];
  const log = { ...silentLog, warn: (...parts: unknown[]) => { warnings.push(parts.join(' ')); } };
  const service = new AskRouteService({ cli, timers, log });
  return { service, calls, warmed, timers, warnings };
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

// ── Warm (S2) ──

test('a request after warming goes through the warm process and reads like a cold one', async () => {
  /* Given */
  const { service, calls, warmed, timers } = harness();
  service.warm();
  const answer = success({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login bug.' });

  /* When */
  const pending = service.route(request);
  warmed[0].sends[0].finish(answer);
  const result = await pending;

  /* Then */
  assert.equal(calls.length, 0);
  assert.deepEqual(warmed[0].bootArgs, routeBootArgs());
  assert.equal(warmed[0].sends[0].args[0], routePrompt(request));
  assert.deepEqual(result, { kind: 'confident', projectPath: APP, prompt: 'Fix the login bug.' });
  assert.equal(timers.pending, 0);
});

test('warming while a process is ready does nothing', () => {
  /* Given */
  const { service, warmed } = harness();
  service.warm();

  /* When */
  service.warm();

  /* Then */
  assert.equal(warmed.length, 1);
});

test('a warm process serves one request, and the next goes cold', async () => {
  /* Given */
  const { service, calls, warmed } = harness();
  service.warm();
  const first = service.route(request);
  warmed[0].sends[0].finish(success({ projectPath: APP, confident: true, candidates: [APP], prompt: 'One.' }));
  await first;

  /* When */
  void service.route(request);

  /* Then */
  assert.equal(warmed[0].sends.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.at(-1), routePrompt(request));
});

test('warming after the warm process was used starts another', async () => {
  /* Given */
  const { service, warmed } = harness();
  service.warm();
  void service.route(request);

  /* When */
  service.warm();

  /* Then */
  assert.equal(warmed.length, 2);
});

test('cancel kills the warm send and answers cancelled', async () => {
  /* Given */
  const { service, warmed } = harness();
  service.warm();
  const pending = service.route(request);

  /* When */
  service.cancel();

  /* Then */
  assert.deepEqual(await pending, { kind: 'cancelled' });
  assert.equal(warmed[0].sends[0].signal.aborted, true);
});

test('a warm process left unused for five minutes is let go, and the next warm starts afresh', () => {
  /* Given */
  const { service, calls, warmed, timers } = harness();
  service.warm();

  /* When */
  timers.tick();
  service.warm();

  /* Then */
  assert.equal(WARM_IDLE_MS, 5 * 60_000);
  assert.equal(warmed.length, 2);
  assert.equal(calls.length, 0);
});

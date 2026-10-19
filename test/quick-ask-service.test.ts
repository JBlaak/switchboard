import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_PATCH_CALL, AskRouteService } from '../src/application/services/ask-route-service';
import { QUICK_ROUTE_CALL, QuickAskService } from '../src/application/services/quick-ask-service';
import { NO_MATCH_LINE } from '../src/domain/ask/route';
import { fakeRenderer, fakeTimers, silentLog } from './support/fakes';
import type { QuickRouter } from '../src/application/services/quick-ask-service';
import type { ClaudeCaller } from '../src/application/ports/claude-cli';
import type { QuickRouteResult, RouteRequest } from '../src/domain/ask/model';
import type { ClaudeRun } from '../src/domain/ask/route';
import type { Project } from '../src/domain/project/project';

/**
 * What Quick Ask does with each routing answer (R2), in main: the launch or
 * the picker goes to the main window, and the pop-up is told what to show.
 */

const APP = '/code/app';
const API = '/code/app-api';
const QUICK = '/code/scratch';

const PROJECTS: Project[] = [
  { projectPath: APP, folder: '-code-app', sessions: [] },
  { projectPath: API, folder: '-code-app-api', sessions: [] },
  { projectPath: 'ssh://box/srv', folder: 'ssh', sessions: [], remote: true },
  { projectPath: `${APP}/.claude/worktrees/try`, folder: '-code-app--claude-worktrees-try', sessions: [] },
];

/** A router that answers each request when the test says so. */
function fakeRouter() {
  const requests: { request: RouteRequest; answer(result: QuickRouteResult): void }[] = [];
  const calls: string[] = [];
  const router: QuickRouter = {
    route(request) {
      return new Promise((resolve) => { requests.push({ request, answer: resolve }); });
    },
    cancel() { calls.push('cancel'); },
    warm() { calls.push('warm'); },
  };
  return { router, requests, calls };
}

function harness({ quickSessionPath = '' } = {}) {
  const { router, requests, calls } = fakeRouter();
  const renderer = fakeRenderer();
  const window: string[] = [];
  let shown: () => void = () => {};
  const service = new QuickAskService({
    router,
    projects: { list: (showArchived) => (showArchived ? [] : PROJECTS) },
    settings: { global: () => ({ quickSessionPath }) },
    renderer,
    mainWindow: { ensureOpen: () => window.push('ensureOpen'), bringForward: () => window.push('bringForward') },
    panel: { onShown: (listener) => { shown = listener; } },
    log: silentLog,
  });
  /** Send `text`, answer it with `result`, and hand back the reply. */
  const ask = async (text: string, result: QuickRouteResult) => {
    const reply = service.route(text);
    requests.at(-1)!.answer(result);
    return await reply;
  };
  return { service, requests, calls, renderer, window, ask, show: () => shown() };
}

test('quick ask: the request offers the local projects, not remotes or worktrees', async () => {
  /* Given */
  const { service, requests } = harness();

  /* When */
  void service.route('fix the upload test');

  /* Then */
  assert.equal(requests[0].request.text, 'fix the upload test');
  assert.deepEqual(requests[0].request.candidates.map(c => c.projectPath), [APP, API]);
});

test('quick ask: a confident answer starts the session in the main window, which stays where it is', async () => {
  /* Given */
  const { ask, renderer, window } = harness();

  /* When */
  const reply = await ask('fix the upload test in app', { kind: 'confident', projectPath: APP, prompt: 'Fix the upload test.' });

  /* Then */
  assert.deepEqual(reply, { kind: 'started', folder: 'app' });
  assert.deepEqual(renderer.only('launchRequested'), [['launchRequested', APP, 'Fix the upload test.']]);
  assert.deepEqual(window, ['ensureOpen']);
});

test('quick ask: an unsure answer lists its candidates by folder, and starts nothing', async () => {
  /* Given */
  const { ask, renderer, window } = harness();

  /* When */
  const reply = await ask('make it faster', { kind: 'unsure', candidates: [API, APP], prompt: 'Make it faster.' });

  /* Then */
  assert.deepEqual(reply, {
    kind: 'choose',
    candidates: [{ projectPath: API, folder: 'app-api' }, { projectPath: APP, folder: 'app' }],
  });
  assert.deepEqual(renderer.events, []);
  assert.deepEqual(window, []);
});

test('quick ask: a choice from the list starts on the rewritten prompt', async () => {
  /* Given */
  const { service, ask, renderer } = harness();
  await ask('make it faster', { kind: 'unsure', candidates: [API, APP], prompt: 'Make it faster.' });

  /* When */
  const reply = service.start(APP);

  /* Then */
  assert.deepEqual(reply, { kind: 'started', folder: 'app' });
  assert.deepEqual(renderer.only('launchRequested'), [['launchRequested', APP, 'Make it faster.']]);
});

test('quick ask: a path the list never offered starts nothing', async () => {
  /* Given */
  const { service, ask, renderer } = harness();
  await ask('make it faster', { kind: 'unsure', candidates: [API], prompt: 'Make it faster.' });

  /* When */
  const reply = service.start('/somewhere/else');

  /* Then */
  assert.deepEqual(reply, { kind: 'unlocked' });
  assert.deepEqual(renderer.events, []);
});

test('quick ask: Tab from the list opens the picker in the main window with the rewritten prompt', async () => {
  /* Given */
  const { service, ask, renderer, window } = harness();
  await ask('make it faster', { kind: 'unsure', candidates: [API, APP], prompt: 'Make it faster.' });

  /* When */
  service.openPicker();

  /* Then */
  assert.deepEqual(renderer.only('pickerRequested'), [['pickerRequested', 'Make it faster.', undefined]]);
  assert.deepEqual(window, ['bringForward']);
});

test('quick ask: no match with a quick folder starts a quick session on the text as typed', async () => {
  /* Given */
  const { ask, renderer, window } = harness({ quickSessionPath: ` ${QUICK} ` });

  /* When */
  const reply = await ask('jot down an idea', { kind: 'noMatch', reason: NO_MATCH_LINE });

  /* Then */
  assert.deepEqual(reply, { kind: 'started', folder: 'scratch' });
  assert.deepEqual(renderer.only('launchRequested'), [['launchRequested', QUICK, 'jot down an idea']]);
  assert.deepEqual(window, ['ensureOpen']);
});

test('quick ask: no match without a quick folder brings the main window forward with the picker and Patch\'s line', async () => {
  /* Given */
  const { ask, renderer, window } = harness();

  /* When */
  const reply = await ask('jot down an idea', { kind: 'noMatch', reason: NO_MATCH_LINE });

  /* Then */
  assert.deepEqual(reply, { kind: 'handedOff' });
  assert.deepEqual(renderer.only('pickerRequested'), [['pickerRequested', 'jot down an idea', NO_MATCH_LINE]]);
  assert.deepEqual(window, ['bringForward']);
});

test('quick ask: a failed call goes where no match goes', async () => {
  /* Given */
  const { ask, renderer } = harness();

  /* When */
  const reply = await ask('jot down an idea', { kind: 'failed', reason: 'Couldn’t run claude.' });

  /* Then */
  assert.deepEqual(reply, { kind: 'handedOff' });
  assert.deepEqual(renderer.only('pickerRequested'), [['pickerRequested', 'jot down an idea', 'Couldn’t run claude.']]);
});

test('quick ask: a capture, until it can be written, goes where no match goes', async () => {
  /* Given */
  const { ask, renderer } = harness({ quickSessionPath: QUICK });

  /* When */
  const reply = await ask('create a task to call Peter', { kind: 'capture', target: 'tasks', text: 'call Peter' });

  /* Then */
  assert.deepEqual(reply, { kind: 'started', folder: 'scratch' });
  assert.deepEqual(renderer.only('launchRequested'), [['launchRequested', QUICK, 'create a task to call Peter']]);
});

test('quick ask: a cancelled call unlocks the box, and Esc cancels the call', async () => {
  /* Given */
  const { service, ask, renderer, calls } = harness();

  /* When */
  service.cancel();
  const reply = await ask('fix it', { kind: 'cancelled' });

  /* Then */
  assert.deepEqual(reply, { kind: 'unlocked' });
  assert.deepEqual(calls, ['cancel']);
  assert.deepEqual(renderer.events, []);
});

test('quick ask: the pop-up coming on screen warms a process', () => {
  /* Given */
  const { calls, show } = harness();

  /* When */
  show();

  /* Then */
  assert.deepEqual(calls, ['warm']);
});

// ── Two boxes ──

/** A `claude` that answers each call when the test says so. */
function fakeCaller() {
  const calls: { args: readonly string[]; signal: AbortSignal; finish(run: ClaudeRun): void }[] = [];
  const cli: ClaudeCaller = {
    call: (args, signal) => new Promise((resolve) => { calls.push({ args, signal, finish: resolve }); }),
    warm: () => { throw new Error('not warmed here'); },
  };
  return { cli, calls };
}

function success(answer: unknown): ClaudeRun {
  return { exitCode: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(answer) }), stderr: '' };
}

test('quick ask: a request from the pop-up and one from the empty-screen box never cancel each other', async () => {
  /* Given */
  const { cli, calls } = fakeCaller();
  const timers = fakeTimers();
  const box = new AskRouteService({ cli, timers, log: silentLog, call: ASK_PATCH_CALL });
  const renderer = fakeRenderer();
  const quickAsk = new QuickAskService({
    router: new AskRouteService({ cli, timers, log: silentLog, call: QUICK_ROUTE_CALL }),
    projects: { list: () => PROJECTS },
    settings: { global: () => ({}) },
    renderer,
    mainWindow: { ensureOpen() {}, bringForward() {} },
    panel: { onShown() {} },
    log: silentLog,
  });
  const fromBox = box.route({ text: 'fix app', candidates: [{ projectPath: APP, folder: '-code-app', recentTitles: [] }] });

  /* When */
  const fromPopUp = quickAsk.route('fix app-api');

  /* Then */
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.signal.aborted), [false, false]);

  /* When */
  calls[0].finish(success({ projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix app.' }));
  calls[1].finish(success({ kind: 'session', captureText: '', projectPath: API, confident: true, candidates: [API], prompt: 'Fix app-api.' }));

  /* Then */
  assert.deepEqual(await fromBox, { kind: 'confident', projectPath: APP, prompt: 'Fix app.' });
  assert.deepEqual(await fromPopUp, { kind: 'started', folder: 'app-api' });

  /* When */
  const again = box.route({ text: 'fix app', candidates: [] });
  const quickAgain = quickAsk.route('fix app-api');
  box.cancel();

  /* Then */
  assert.deepEqual(await again, { kind: 'cancelled' });
  assert.deepEqual([calls[2].signal.aborted, calls[3].signal.aborted], [true, false]);
  calls[3].finish(success({ kind: 'session', captureText: '', projectPath: API, confident: true, candidates: [API], prompt: 'Fix app-api.' }));
  assert.deepEqual(await quickAgain, { kind: 'started', folder: 'app-api' });
});

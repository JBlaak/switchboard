import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ASK_PATCH_CALL, AskRouteService } from '../src/application/services/ask-route-service';
import { QuickAskService, quickRouteCall } from '../src/application/services/quick-ask-service';
import { captureArgs, noAnswerLine, undoArgs } from '../src/domain/ask/capture';
import { NO_QUICK_FOLDER_LINE } from '../src/domain/ask/quick-ask';
import { NO_MATCH_LINE } from '../src/domain/ask/route';
import { NO_SKILLS } from '../src/domain/ask/skills';
import { fakeRenderer, fakeTimers, silentLog } from './support/fakes';
import type { QuickRouter } from '../src/application/services/quick-ask-service';
import type { ClaudeCaller } from '../src/application/ports/claude-cli';
import type { McpServers } from '../src/application/ports/mcp-servers';
import type { CaptureTarget } from '../src/domain/ask/model';
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

const SKILLS = { everywhere: ['grill-me', 'tdd'], byProject: { [APP]: ['release'] } };

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

/**
 * The servers in `~/.claude.json`, writing each config to a numbered path and
 * noting what is removed. `urls` gives a server its URL.
 */
function fakeMcpServers(names: string[] = ['blaaktasks', 'james'], urls: Record<string, string> = { blaaktasks: TASKS_URL }) {
  const written: string[] = [];
  const removed: string[] = [];
  const servers: McpServers = {
    has: (name) => names.includes(name),
    write: (name) => {
      if (!names.includes(name)) return null;
      const path = `/tmp/switchboard-mcp-${written.length + 1}.json`;
      written.push(path);
      return { path, remove: () => { removed.push(path); } };
    },
    headersFor: () => null,
    nameFor: (url) => names.find(name => urls[name] === url) ?? null,
    removeAll() {},
  };
  /** The configs written and not removed. */
  const left = () => written.filter(path => !removed.includes(path));
  return { servers, written, removed, left };
}

/** The BlaakTasks URL the tests set, so a task capture is offered (#252). */
const TASKS_URL = 'https://tasks.example.com/mcp';

function harness({
  quickSessionPath = '', servers = ['blaaktasks', 'james'], blaakTasksUrl = TASKS_URL,
  urls = { blaaktasks: TASKS_URL } as Record<string, string>,
} = {}) {
  const { router, requests, calls } = fakeRouter();
  const { cli, calls: cliCalls } = fakeCaller();
  const mcp = fakeMcpServers(servers, urls);
  const timers = fakeTimers();
  const renderer = fakeRenderer();
  const window: string[] = [];
  const saving: CaptureTarget[] = [];
  const skillLookups: string[][] = [];
  let ids = 0;
  let shown: () => void = () => {};
  const service = new QuickAskService({
    router,
    projects: { list: (showArchived) => (showArchived ? [] : PROJECTS) },
    skills: { list: (projectPaths) => { skillLookups.push(projectPaths); return SKILLS; } },
    settings: { global: () => ({ quickSessionPath, blaakTasksUrl }) },
    renderer,
    mainWindow: { ensureOpen: () => window.push('ensureOpen'), bringForward: () => window.push('bringForward') },
    panel: { onShown: (listener) => { shown = listener; } },
    popUp: { saving: (target) => saving.push(target) },
    cli, mcpServers: mcp.servers, timers,
    ids: { newId: () => `capture-${++ids}` },
    log: silentLog,
  });
  /** Send `text`, answer it with `result`, and hand back the reply. */
  const ask = async (text: string, result: QuickRouteResult) => {
    const reply = service.route(text);
    requests.at(-1)!.answer(result);
    return await reply;
  };
  /** Let the capture or undo call in flight start, once its config is written. */
  const started = async (count: number) => {
    while (cliCalls.length < count) await new Promise(resolve => setImmediate(resolve));
    return cliCalls[count - 1];
  };
  return { service, requests, calls, renderer, window, ask, skillLookups, show: () => shown(), cli, cliCalls, started, mcp, timers, saving };
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

test('quick ask: the request carries the skills of those projects, so the route keeps their names', async () => {
  /* Given */
  const { service, requests, skillLookups } = harness();

  /* When */
  void service.route('grill me on the upload flow');

  /* Then */
  assert.deepEqual(skillLookups, [[APP, API]]);
  assert.deepEqual(requests[0].request.skills, SKILLS);
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

test('quick ask: ⌘Enter starts a quick session on the text as typed, without routing it', () => {
  /* Given */
  const { service, requests, renderer, window } = harness({ quickSessionPath: ` ${QUICK} ` });

  /* When */
  const reply = service.quick('jot down an idea');

  /* Then */
  assert.deepEqual(reply, { kind: 'started', folder: 'scratch' });
  assert.equal(requests.length, 0);
  assert.deepEqual(renderer.only('launchRequested'), [['launchRequested', QUICK, 'jot down an idea']]);
  assert.deepEqual(window, ['ensureOpen']);
});

test('quick ask: ⌘Enter without a quick folder hands the text as typed to the picker, without routing it', () => {
  /* Given */
  const { service, requests, renderer, window } = harness();

  /* When */
  const reply = service.quick('jot down an idea');

  /* Then */
  assert.deepEqual(reply, { kind: 'handedOff' });
  assert.equal(requests.length, 0);
  assert.deepEqual(renderer.only('pickerRequested'), [['pickerRequested', 'jot down an idea', NO_QUICK_FOLDER_LINE]]);
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

test('quick ask: a request from the pop-up and one from the empty-screen box never cancel each other', async () => {
  /* Given */
  const { cli, calls } = fakeCaller();
  const timers = fakeTimers();
  const box = new AskRouteService({ cli, timers, log: silentLog, call: ASK_PATCH_CALL });
  const renderer = fakeRenderer();
  const quickAsk = new QuickAskService({
    router: new AskRouteService({ cli, timers, log: silentLog, call: quickRouteCall({ global: () => ({}) }) }),
    projects: { list: () => PROJECTS },
    skills: { list: () => NO_SKILLS },
    settings: { global: () => ({}) },
    renderer,
    mainWindow: { ensureOpen() {}, bringForward() {} },
    panel: { onShown() {} },
    popUp: { saving() {} },
    cli, mcpServers: fakeMcpServers().servers, timers, ids: { newId: () => 'capture-1' },
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

// ── Captures (#151) ──

const TASK_TEXT = 'create a task to call Peter on Thursday';
const SAVE_TEXT = 'save https://example.com/liquid-glass';

/** The route said capture: answer it, and hand back the reply still to come. */
function captureSent(h: ReturnType<typeof harness>, typed: string, target: CaptureTarget, text: string) {
  const reply = h.service.route(typed);
  h.requests.at(-1)!.answer({ kind: 'capture', target, text });
  return reply;
}

function failure(message: string): ClaudeRun {
  return { exitCode: 1, stdout: JSON.stringify({ type: 'result', is_error: true, result: message }), stderr: '' };
}

test('quick ask: a task goes to BlaakTasks through its one tool, the pop-up told it is saving, and the config removed', async () => {
  /* Given */
  const h = harness();

  /* When */
  const reply = captureSent(h, TASK_TEXT, 'tasks', 'call Peter on Thursday');
  const call = await h.started(1);

  /* Then */
  assert.deepEqual(h.saving, ['tasks']);
  assert.deepEqual(call.args, captureArgs('tasks', 'call Peter on Thursday', 'capture-1', h.mcp.written[0]));

  /* When */
  call.finish(success({ ids: ['task-1'], summary: 'Call Peter · due Thu' }));

  /* Then */
  assert.deepEqual(await reply, { kind: 'saved', target: 'tasks', summary: 'Call Peter · due Thu' });
  assert.deepEqual(h.mcp.left(), []);
  assert.deepEqual(h.renderer.events, []);
});

test('quick ask: a save goes to James with a captureId Switchboard made', async () => {
  /* Given */
  const h = harness();

  /* When */
  const reply = captureSent(h, SAVE_TEXT, 'james', 'https://example.com/liquid-glass');
  const call = await h.started(1);
  call.finish(success({ ids: ['j-9'], summary: 'The Liquid Glass article' }));

  /* Then */
  assert.equal(call.args.at(-1), 'captureId: capture-1\n\nText:\nhttps://example.com/liquid-glass');
  assert.ok(call.args.includes('mcp__james__capture'));
  assert.deepEqual(await reply, { kind: 'saved', target: 'james', summary: 'The Liquid Glass article' });
  assert.deepEqual(h.mcp.left(), []);
});

test('quick ask: a failed capture answers Patch\'s line, and the config is removed', async () => {
  /* Given */
  const h = harness();

  /* When */
  const reply = captureSent(h, SAVE_TEXT, 'james', 'https://example.com/liquid-glass');
  (await h.started(1)).finish(failure('MCP server james failed'));

  /* Then */
  assert.deepEqual(await reply, { kind: 'captureFailed', reason: noAnswerLine('james') });
  assert.deepEqual(h.mcp.left(), []);
});

test('quick ask: Enter on the same text after a failure retries with the same captureId, without routing again', async () => {
  /* Given */
  const h = harness();
  const first = captureSent(h, SAVE_TEXT, 'james', 'https://example.com/liquid-glass');
  (await h.started(1)).finish(failure('timeout'));
  await first;

  /* When */
  const retry = h.service.route(SAVE_TEXT);
  const call = await h.started(2);
  call.finish(success({ ids: ['j-9'], summary: 'The Liquid Glass article' }));

  /* Then */
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.saving, ['james', 'james']);
  assert.deepEqual(call.args, captureArgs('james', 'https://example.com/liquid-glass', 'capture-1', h.mcp.written[1]));
  assert.deepEqual(await retry, { kind: 'saved', target: 'james', summary: 'The Liquid Glass article' });
});

test('quick ask: edited text after a failure is a new request, routed again', async () => {
  /* Given */
  const h = harness();
  const first = captureSent(h, SAVE_TEXT, 'james', 'https://example.com/liquid-glass');
  (await h.started(1)).finish(failure('timeout'));
  await first;

  /* When */
  void h.service.route('fix the upload test');

  /* Then */
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].request.text, 'fix the upload test');
});

test('quick ask: a capture that takes too long is killed and fails, and the config is removed', async () => {
  /* Given */
  const h = harness();
  const reply = captureSent(h, TASK_TEXT, 'tasks', 'call Peter on Thursday');
  const call = await h.started(1);

  /* When */
  h.timers.tick();
  call.finish({ exitCode: null, stdout: '', stderr: '' });

  /* Then */
  assert.equal(call.signal.aborted, true);
  assert.deepEqual(await reply, { kind: 'captureFailed', reason: noAnswerLine('tasks') });
  assert.deepEqual(h.mcp.left(), []);
});

test('quick ask: a capture whose claude cannot start fails, and the config is removed', async () => {
  /* Given */
  const h = harness();
  h.cli.call = () => Promise.reject(new Error('spawn claude ENOENT'));

  /* When */
  const reply = await captureSent(h, TASK_TEXT, 'tasks', 'call Peter on Thursday');

  /* Then */
  assert.deepEqual(reply, { kind: 'captureFailed', reason: noAnswerLine('tasks') });
  assert.equal(h.mcp.written.length, 1);
  assert.deepEqual(h.mcp.left(), []);
});

test('quick ask: a server missing from ~/.claude.json takes the no-match path, with no call and no config', async () => {
  /* Given */
  const h = harness({ servers: ['james'] });

  /* When */
  const reply = await captureSent(h, TASK_TEXT, 'tasks', 'call Peter on Thursday');

  /* Then */
  assert.deepEqual(reply, { kind: 'handedOff' });
  assert.deepEqual(h.renderer.only('pickerRequested'), [['pickerRequested', TASK_TEXT, NO_MATCH_LINE]]);
  assert.deepEqual([h.cliCalls.length, h.mcp.written.length, h.saving.length], [0, 0, 0]);
});

test('quick ask: a server missing, with a quick folder, starts a quick session on the text as typed', async () => {
  /* Given */
  const h = harness({ servers: [], quickSessionPath: QUICK });

  /* When */
  const reply = await captureSent(h, SAVE_TEXT, 'james', 'https://example.com/liquid-glass');

  /* Then */
  assert.deepEqual(reply, { kind: 'started', folder: 'scratch' });
  assert.deepEqual(h.renderer.only('launchRequested'), [['launchRequested', QUICK, SAVE_TEXT]]);
});

// ── BlaakTasks off (#252) ──

test('quick ask: with no BlaakTasks URL a task capture takes the no-match path, with no call and no config', async () => {
  /* Given */
  const h = harness({ blaakTasksUrl: '' });

  /* When */
  const reply = await captureSent(h, TASK_TEXT, 'tasks', 'call Peter on Thursday');

  /* Then */
  assert.deepEqual(reply, { kind: 'handedOff' });
  assert.deepEqual(h.renderer.only('pickerRequested'), [['pickerRequested', TASK_TEXT, NO_MATCH_LINE]]);
  assert.deepEqual([h.cliCalls.length, h.mcp.written.length, h.saving.length], [0, 0, 0]);
});

test('quick ask: with no BlaakTasks URL a save still goes to James', async () => {
  /* Given */
  const h = harness({ blaakTasksUrl: '  ' });

  /* When */
  const reply = captureSent(h, SAVE_TEXT, 'james', 'https://example.com/liquid-glass');
  (await h.started(1)).finish(success({ ids: ['j-9'], summary: 'The Liquid Glass article' }));

  /* Then */
  assert.deepEqual(await reply, { kind: 'saved', target: 'james', summary: 'The Liquid Glass article' });
});

test('quick ask: the routing call offers the "task" kind only while a BlaakTasks URL is set', () => {
  /* Given */
  let url = '';
  const call = quickRouteCall({ global: () => ({ blaakTasksUrl: url }) });
  const instructions = () => { const boot = call.bootArgs(); return boot[boot.indexOf('--system-prompt') + 1]; };

  /* When */
  const off = instructions();
  url = TASKS_URL;
  const on = instructions();

  /* Then */
  assert.doesNotMatch(off, /"task"|BlaakTasks|remind me to/);
  assert.match(off, /"kind": "session" or "save"/);
  assert.match(on, /"kind": "session" or "task" or "save"/);
});

test('quick ask: with no BlaakTasks URL a "task" answer is not read as a capture', () => {
  /* Given */
  const call = quickRouteCall({ global: () => ({}) });
  const request = { text: 'remind me to call Peter', candidates: [], skills: NO_SKILLS };
  const answer = { kind: 'task', captureText: 'call Peter', projectPath: null, confident: false, candidates: [], prompt: '' };

  /* When */
  const result = call.read(success(answer), request);

  /* Then */
  assert.notEqual(result.kind, 'capture');
});

test('quick ask: a task goes to the server with the BlaakTasks URL, under whatever name it has', async () => {
  /* Given */
  const h = harness({ servers: ['my-tasks', 'james'], urls: { 'my-tasks': TASKS_URL } });
  const written: string[] = [];
  const write = h.mcp.servers.write;
  h.mcp.servers.write = (name) => { written.push(name); return write(name); };

  /* When */
  const reply = captureSent(h, TASK_TEXT, 'tasks', 'call Peter on Thursday');
  const call = await h.started(1);
  call.finish(success({ ids: ['task-1'], summary: 'Call Peter' }));

  /* Then */
  assert.deepEqual(written, ['my-tasks']);
  assert.deepEqual(call.args, captureArgs('tasks', 'call Peter on Thursday', 'capture-1', h.mcp.written[0], 'my-tasks'));
  assert.ok(call.args.includes('mcp__my-tasks__capture'));
  assert.ok(!call.args.some(arg => arg.includes('mcp__blaaktasks__')));
  assert.deepEqual(await reply, { kind: 'saved', target: 'tasks', summary: 'Call Peter' });
});

test('quick ask: ⌘Z on a task undoes it through the server it went to, under its own name', async () => {
  /* Given */
  const h = harness({ servers: ['my-tasks', 'james'], urls: { 'my-tasks': TASKS_URL } });
  await saved(h, 'tasks', ['task-1']);

  /* When */
  const undo = h.service.undo();
  const call = await h.started(2);
  call.finish(success({ ok: true }));

  /* Then */
  assert.deepEqual(call.args, undoArgs('tasks', ['task-1'], h.mcp.written[1], 'my-tasks'));
  assert.ok(call.args.includes('mcp__my-tasks__undo_capture'));
  assert.deepEqual(await undo, { ok: true });
});

test('quick ask: a server named blaaktasks at another URL is not the one, and the task takes the no-match path', async () => {
  /* Given */
  const h = harness({ urls: { blaaktasks: 'https://elsewhere.example.com/mcp' } });

  /* When */
  const reply = await captureSent(h, TASK_TEXT, 'tasks', 'call Peter on Thursday');

  /* Then */
  assert.deepEqual(reply, { kind: 'handedOff' });
  assert.deepEqual([h.cliCalls.length, h.mcp.written.length], [0, 0]);
});

// ── Undo ──

async function saved(h: ReturnType<typeof harness>, target: CaptureTarget, ids: string[]): Promise<void> {
  const reply = captureSent(h, target === 'tasks' ? TASK_TEXT : SAVE_TEXT, target, 'the text');
  (await h.started(h.cliCalls.length + 1)).finish(success({ ids, summary: 'Something' }));
  await reply;
}

test('quick ask: ⌘Z takes back what the capture stored, by its ids, and the config is removed', async () => {
  /* Given */
  const h = harness();
  await saved(h, 'tasks', ['task-1']);

  /* When */
  const undone = h.service.undo();
  const call = await h.started(2);
  call.finish(success({ ok: true }));

  /* Then */
  assert.deepEqual(call.args, undoArgs('tasks', ['task-1'], h.mcp.written[1]));
  assert.deepEqual(await undone, { ok: true });
  assert.deepEqual(h.mcp.left(), []);
});

test('quick ask: James\'s capture is undone by its id', async () => {
  /* Given */
  const h = harness();
  await saved(h, 'james', ['j-9']);

  /* When */
  const undone = h.service.undo();
  const call = await h.started(2);
  call.finish(success({ ok: true }));

  /* Then */
  assert.deepEqual(call.args, undoArgs('james', ['j-9'], h.mcp.written[1]));
  assert.deepEqual(await undone, { ok: true });
});

test('quick ask: an undo that fails answers not ok, and the config is removed', async () => {
  /* Given */
  const h = harness();
  await saved(h, 'tasks', ['task-1']);

  /* When */
  const undone = h.service.undo();
  (await h.started(2)).finish(success({ ok: false }));

  /* Then */
  assert.deepEqual(await undone, { ok: false });
  assert.deepEqual(h.mcp.left(), []);
});

test('quick ask: there is one undo per capture, and none once its ten minutes are up', async () => {
  /* Given */
  const h = harness();
  await saved(h, 'tasks', ['task-1']);
  const first = h.service.undo();
  (await h.started(2)).finish(success({ ok: true }));
  await first;

  /* When */
  const again = await h.service.undo();

  /* Then */
  assert.deepEqual(again, { ok: false });
  assert.equal(h.cliCalls.length, 2);

  /* Given */
  await saved(h, 'james', ['j-9']);

  /* When */
  h.timers.tick();
  const late = await h.service.undo();

  /* Then */
  assert.deepEqual(late, { ok: false });
  assert.equal(h.cliCalls.length, 3);
});

test('quick ask: with nothing captured, ⌘Z does nothing', async () => {
  /* Given */
  const h = harness();

  /* When */
  const undone = await h.service.undo();

  /* Then */
  assert.deepEqual(undone, { ok: false });
  assert.deepEqual([h.cliCalls.length, h.mcp.written.length], [0, 0]);
});

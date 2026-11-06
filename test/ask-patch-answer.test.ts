/**
 * Patch answering a simple question itself: the routing call's `answer`, and
 * what the empty screen's box and the Quick Ask pop-up do with it. A request
 * that needs a session still routes as before, and the phone and task routing
 * never get an answer.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    ASK_PATCH_SYSTEM_PROMPT,
    GARBLED_LINE,
    ROUTE_SYSTEM_PROMPT,
    askPatchArgs,
    askPatchBootArgs,
    readAskPatchRun,
    readRouteRun,
    routeArgs,
    routePrompt,
} from '../src/domain/ask/route';
import {QUICK_ROUTE_SYSTEM_PROMPT, readQuickRouteRun} from '../src/domain/ask/quick-route';
import {quickAskOutcome} from '../src/domain/ask/quick-ask';
import {ASK_PATCH_CALL, EMPTY_SCREEN_CALL} from '../src/application/services/ask-route-service';
import {QuickAskService} from '../src/application/services/quick-ask-service';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {askOutcome} from '../src/renderer/state/ask-slice';
import {initialQuickAskState, quickAskReducer} from '../src/renderer/state/quick-ask-slice';
import {ANSWER_BEAT, askKey, outcomeBeat} from '../src/renderer/ui/ask/ask-keys';
import {quickAskKey} from '../src/renderer/quick-ask/quick-ask-keys';
import {fakeRenderer, fakeTimers, silentLog} from './support/fakes';
import type {QuickRouter} from '../src/application/services/quick-ask-service';
import type {AskPatchResult, QuickRouteResult, RouteRequest} from '../src/domain/ask/model';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {QuickAskEvent, QuickAskState} from '../src/renderer/state/quick-ask-slice';

const APP = '/code/app';
const SITE = '/code/site';
const QUESTION = 'what does git rebase --onto do?';
const ANSWER = 'It replays your commits onto a new base:\ngit rebase --onto <new-base> <old-base> <branch>';
const NO_ROUTE = {projectPath: null, confident: false, candidates: [], prompt: ''};

function request(text = QUESTION): RouteRequest {
    return {
        text,
        candidates: [APP, SITE].map((projectPath) => ({projectPath, folder: projectPath, recentTitles: []})),
    };
}

function run(answer: unknown): {exitCode: number; stdout: string; stderr: string} {
    const result = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return {exitCode: 0, stdout: JSON.stringify({type: 'result', is_error: false, result}) + '\n', stderr: ''};
}

// ── The empty screen's call ──

test('the empty screen asks with the routing flags and instructions that may answer', () => {
    /* Given */
    const req = request();

    /* When */
    const args = askPatchArgs(req);

    /* Then */
    const flags = routeArgs(req);
    const prompt = flags.indexOf('--system-prompt');
    assert.deepEqual(
        args.filter((_, i) => i !== prompt + 1),
        flags.filter((_, i) => i !== prompt + 1),
    );
    assert.equal(args[prompt + 1], ASK_PATCH_SYSTEM_PROMPT);
    assert.deepEqual(askPatchBootArgs(), args.slice(0, -1));
    assert.equal(args.at(-1), routePrompt(req));
    assert.match(ASK_PATCH_SYSTEM_PROMPT, /First, decide whether to answer the request yourself:/);
    assert.match(ASK_PATCH_SYSTEM_PROMPT, /"answer": "<your answer>" or ""/);
    assert.match(ASK_PATCH_SYSTEM_PROMPT, /When in doubt, leave it ""/);
});

test("the phone's and the tasks' routing call never offers an answer", () => {
    /* Given */
    const call = ASK_PATCH_CALL;

    /* When */
    const args = call.args(request());

    /* Then */
    assert.ok(!ROUTE_SYSTEM_PROMPT.includes('answer is'));
    assert.ok(args.includes(ROUTE_SYSTEM_PROMPT));
    assert.equal(call.read, readRouteRun);
    assert.equal(EMPTY_SCREEN_CALL.read, readAskPatchRun);
});

test('a simple question comes back as Patch’s answer, trimmed', () => {
    /* Given */
    const answered = run({answer: `  ${ANSWER}\n`, ...NO_ROUTE});

    /* When */
    const result = readAskPatchRun(answered, request());

    /* Then */
    assert.deepEqual(result, {kind: 'answer', text: ANSWER});
});

test('an empty answer routes as before', () => {
    /* Given */
    const routed = run({answer: '', projectPath: APP, confident: true, candidates: [APP], prompt: 'Fix the login.'});

    /* When */
    const result = readAskPatchRun(routed, request('fix the login in app'));

    /* Then */
    assert.deepEqual(result, {kind: 'confident', projectPath: APP, prompt: 'Fix the login.'});
});

test('an answer without the answer key routes as before', () => {
    /* Given */
    const routed = run({projectPath: null, confident: false, candidates: [SITE], prompt: 'Make it faster.'});

    /* When */
    const result = readAskPatchRun(routed, request('make it faster'));

    /* Then */
    assert.deepEqual(result, {kind: 'unsure', candidates: [SITE], prompt: 'Make it faster.'});
});

test('a whitespace-only answer is no answer', () => {
    /* Given */
    const routed = run({answer: '  \n ', ...NO_ROUTE});

    /* When */
    const result = readAskPatchRun(routed, request());

    /* Then */
    assert.equal(result.kind, 'noMatch');
});

test('prose, or keys of its own, are garbled', () => {
    /* Given */
    const prose = run('Rebase moves commits.');
    const extra = run({answer: '', mood: 'happy', ...NO_ROUTE});

    /* When */
    const results = [readAskPatchRun(prose, request()), readAskPatchRun(extra, request())];

    /* Then */
    assert.deepEqual(results, [
        {kind: 'failed', reason: GARBLED_LINE},
        {kind: 'failed', reason: GARBLED_LINE},
    ]);
});

test('a failed call reads as the routing call reads it', () => {
    /* Given */
    const failed = {exitCode: 1, stdout: '', stderr: 'boom'};

    /* When */
    const result = readAskPatchRun(failed, request());

    /* Then */
    assert.deepEqual(result, readRouteRun(failed, request()));
});

// ── Quick Ask's call ──

test('Quick Ask’s instructions may answer too', () => {
    /* Given */
    const instructions = QUICK_ROUTE_SYSTEM_PROMPT;

    /* When */
    const shape = instructions.slice(instructions.lastIndexOf('Answering:'));

    /* Then */
    assert.match(instructions, /First, decide whether to answer the request yourself:/);
    assert.match(shape, /"captureText": "<the text to capture>" or "", "answer": "<your answer>" or ""/);
});

test('Quick Ask: a simple question comes back as Patch’s answer', () => {
    /* Given */
    const answered = run({kind: 'session', captureText: '', answer: ANSWER, ...NO_ROUTE});

    /* When */
    const result = readQuickRouteRun(answered, request());

    /* Then */
    assert.deepEqual(result, {kind: 'answer', text: ANSWER});
});

test('Quick Ask: a capture wins over an answer', () => {
    /* Given */
    const both = run({kind: 'task', captureText: 'call Peter', answer: 'Sure.', ...NO_ROUTE});

    /* When */
    const result = readQuickRouteRun(both, request('remind me to call Peter'));

    /* Then */
    assert.deepEqual(result, {kind: 'capture', target: 'tasks', text: 'call Peter'});
});

test('Quick Ask: a session with an empty answer routes as before', () => {
    /* Given */
    const routed = run({
        kind: 'session',
        captureText: '',
        answer: '',
        projectPath: SITE,
        confident: true,
        candidates: [SITE],
        prompt: 'Fix the build.',
    });

    /* When */
    const result = readQuickRouteRun(routed, request('fix the build in site'));

    /* Then */
    assert.deepEqual(result, {kind: 'confident', projectPath: SITE, prompt: 'Fix the build.'});
});

test('Quick Ask: an answer is shown, whatever the Quick Session Folder', () => {
    /* Given */
    const result: QuickRouteResult = {kind: 'answer', text: ANSWER};

    /* When */
    const outcomes = [quickAskOutcome(result, QUESTION, ''), quickAskOutcome(result, QUESTION, '/code/scratch')];

    /* Then */
    assert.deepEqual(outcomes, [
        {kind: 'answer', text: ANSWER},
        {kind: 'answer', text: ANSWER},
    ]);
});

function quickService(quickSessionPath = '/code/scratch') {
    const answers: ((result: QuickRouteResult) => void)[] = [];
    const router: QuickRouter = {
        route: () => new Promise((resolve) => answers.push(resolve)),
        cancel() {},
        warm() {},
    };
    const renderer = fakeRenderer();
    const window: string[] = [];
    const service = new QuickAskService({
        router,
        projects: {list: () => [{projectPath: APP, folder: '-code-app', sessions: []}]},
        skills: {list: () => ({everywhere: [], byProject: {}})},
        settings: {global: () => ({quickSessionPath})},
        renderer,
        mainWindow: {ensureOpen: () => window.push('ensureOpen'), bringForward: () => window.push('bringForward')},
        panel: {onShown() {}},
        popUp: {saving() {}},
        cli: {call: () => Promise.reject(new Error('no capture here'))},
        mcpServers: {has: () => false, write: () => null, headersFor: () => null, nameFor: () => null, removeAll() {}},
        timers: fakeTimers(),
        ids: {newId: () => 'id'},
        log: silentLog,
    });
    return {service, answers, renderer, window};
}

test('Quick Ask service: an answer goes back to the pop-up and starts nothing', async () => {
    /* Given */
    const {service, answers, renderer, window} = quickService();

    /* When */
    const reply = service.route(QUESTION);
    answers[0]({kind: 'answer', text: ANSWER});

    /* Then */
    assert.deepEqual(await reply, {kind: 'answered', text: ANSWER});
    assert.deepEqual(renderer.events, []);
    assert.deepEqual(window, []);
});

test('Quick Ask service: a request that needs a session still starts one', async () => {
    /* Given */
    const {service, answers, renderer} = quickService();

    /* When */
    const reply = service.route('fix the login in app');
    answers[0]({kind: 'confident', projectPath: APP, prompt: 'Fix the login.'});

    /* Then */
    assert.deepEqual(await reply, {kind: 'started', folder: 'app'});
    assert.deepEqual(renderer.only('launchRequested'), [['launchRequested', APP, 'Fix the login.']]);
});

// ── The empty screen's box ──

function runApp(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

function answeredBox(result: AskPatchResult = {kind: 'answer', text: ANSWER}): RendererState {
    const waiting = runApp(initialRendererState(), {type: 'askTextChanged', text: QUESTION}, {type: 'askSent'});
    return runApp(waiting, {type: 'askAnswered', asked: waiting.ask.asked, result});
}

test('box: an answer unlocks it, keeps the question and shows the answer', () => {
    /* Given */
    const result: AskPatchResult = {kind: 'answer', text: ANSWER};

    /* When */
    const state = answeredBox(result);

    /* Then */
    assert.equal(state.ask.phase, 'editing');
    assert.equal(state.ask.text, QUESTION);
    assert.equal(state.ask.answer, ANSWER);
    assert.equal(state.ask.handedOff, false);
    assert.deepEqual(askOutcome(result, QUESTION), {kind: 'answer', text: ANSWER});
});

test('box: a routed answer shows no answer', () => {
    /* Given */
    const result: AskPatchResult = {kind: 'confident', projectPath: APP, prompt: 'Fix it.'};

    /* When */
    const state = answeredBox(result);

    /* Then */
    assert.equal(state.ask.answer, '');
    assert.equal(state.ask.text, '');
});

test('box: typing, sending again, ⌘Enter or Esc put the answer away', () => {
    /* Given */
    const shown = answeredBox();

    /* When */
    const afterTyping = runApp(shown, {type: 'askTextChanged', text: QUESTION + ' again'});
    const afterSending = runApp(shown, {type: 'askSent'});
    const afterQuick = runApp(shown, {type: 'askQuickSent', quickFolder: '/code/scratch'});
    const afterEsc = runApp(shown, {type: 'askAnswerDismissed'});

    /* Then */
    for (const state of [afterTyping, afterSending, afterQuick, afterEsc]) assert.equal(state.ask.answer, '');
    assert.equal(afterEsc.ask.text, QUESTION);
    assert.equal(afterSending.ask.phase, 'waiting');
});

test('box: Esc puts the answer away only while one shows', () => {
    /* Given */
    const esc = {key: 'Escape', shiftKey: false, isComposing: false};

    /* When */
    const withAnswer = askKey('editing', esc, true);
    const without = askKey('editing', esc);
    const enter = askKey('editing', {key: 'Enter', shiftKey: false, metaKey: true, isComposing: false}, true);

    /* Then */
    assert.equal(withAnswer, 'dismissAnswer');
    assert.equal(without, null);
    assert.equal(enter, 'quick');
});

test('box: Patch says a line of its own with the answer', () => {
    /* Given */
    const outcome = askOutcome({kind: 'answer', text: ANSWER}, QUESTION);

    /* When */
    const beat = outcomeBeat(outcome);

    /* Then */
    assert.deepEqual(beat, ANSWER_BEAT);
});

// ── The Quick Ask pop-up ──

function runQuick(state: QuickAskState, ...events: QuickAskEvent[]): QuickAskState {
    return events.reduce((s, e) => quickAskReducer(Object.freeze(s), e), state);
}

function answeredPopUp(): QuickAskState {
    const waiting = runQuick(initialQuickAskState, {type: 'askTextChanged', text: QUESTION}, {type: 'askSent'});
    return runQuick(waiting, {
        type: 'quickAskReplied',
        asked: waiting.box.asked,
        reply: {kind: 'answered', text: ANSWER},
    });
}

test('pop-up: an answer shows under the box, the question kept, nothing on top', () => {
    /* Given */
    const state = answeredPopUp();

    /* When */
    const {box, result} = state;

    /* Then */
    assert.equal(box.phase, 'editing');
    assert.equal(box.text, QUESTION);
    assert.equal(box.answer, ANSWER);
    assert.equal(result, null);
});

test('pop-up: closing puts the answer away and keeps the draft', () => {
    /* Given */
    const shown = answeredPopUp();

    /* When */
    const closed = runQuick(shown, {type: 'quickAskClosed'});

    /* Then */
    assert.equal(closed.box.answer, '');
    assert.equal(closed.box.text, QUESTION);
});

test('pop-up: Esc under an answer closes it; ⌘Enter starts a session', () => {
    /* Given */
    const press = (key: string, metaKey = false) => ({key, shiftKey: false, metaKey, isComposing: false});

    /* When */
    const esc = quickAskKey('editing', press('Escape'));
    const quick = quickAskKey('editing', press('Enter', true));

    /* Then */
    assert.equal(esc, 'dismiss');
    assert.equal(quick, 'quick');
});

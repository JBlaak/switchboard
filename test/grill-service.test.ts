import {test} from 'node:test';
import assert from 'node:assert/strict';

import {ActiveSession} from '../src/application/model/active-session';
import {SessionRegistry} from '../src/application/model/session-registry';
import {ANSWER_FIRST, BUSY_ASK, BUSY_SEND, GrillService, ROUND_CLOSED} from '../src/application/services/grill-service';
import {QuestionService} from '../src/application/services/question-service';
import {fakePty, fakeRenderer, silentLog} from './support/fakes';
import type {EndedTurn, GrillChanged, GrillView} from '../src/domain/grill/model';
import type {PendingQuestions, QuestionsSettled} from '../src/domain/questions/question';

/**
 * The grilling card's main-process side, driven through the hooks it is
 * handed (turns, prompts, subagents) and the card's calls, with a real
 * QuestionService for the pending set and a fake prompter for the terminal.
 */

function harness() {
    const registry = new SessionRegistry();
    const renderer = fakeRenderer();
    const prompter = fakePrompter();
    const questions = new QuestionService({
        registry,
        renderer,
        endpoint: {url: null, token: 't'},
        clock: {now: () => 1_000},
        log: silentLog,
    });
    const grill = new GrillService({registry, renderer, prompter, questions, log: silentLog});
    const addSession = (id: string): ActiveSession => {
        const session = new ActiveSession({
            pty: fakePty(),
            projectPath: '/repo',
            projectFolder: '-repo',
            knownTranscriptIds: new Set(),
            sessionSlug: null,
            isPlainTerminal: false,
            remote: null,
            openedAt: 0,
        });
        registry.add(id, session);
        return session;
    };
    addSession('s1');

    /** The latest view the renderer was told for s1. */
    const view = (): GrillView | null => {
        const changes = renderer.only('grillChanged');
        return changes.length ? (changes[changes.length - 1][1] as GrillChanged).view : null;
    };
    const roundId = () => view()!.roundId;

    return {registry, renderer, prompter, questions, grill, addSession, view, roundId};
}

/** Records what is typed in; a test sets busy, and fires idle and exit. */
function fakePrompter() {
    const sent: [string, string][] = [];
    const idle = new Set<() => void>();
    const exits = new Set<() => void>();
    let busy = false;
    return {
        sent,
        setBusy(value: boolean) {
            busy = value;
        },
        idle() {
            for (const fn of [...idle]) fn();
        },
        exit() {
            for (const fn of [...exits]) fn();
        },
        watchingIdle: () => idle.size,
        isBusy: () => busy,
        send(sessionId: string, prompt: string) {
            sent.push([sessionId, prompt]);
        },
        onIdle(_id: string, fn: () => void) {
            idle.add(fn);
            return {dispose: () => void idle.delete(fn)};
        },
        onExit(_id: string, fn: () => void) {
            exits.add(fn);
            return {dispose: () => void exits.delete(fn)};
        },
    };
}

interface Q {
    n: number;
    title: string;
    reason?: string;
    rec?: string;
}

function roundText(questions: Q[]): string {
    return [
        'Here is the round.',
        '',
        ...questions.flatMap((q) => [
            `❓ **Q${q.n} - ${q.title}**: ${q.reason ?? `Why ${q.title}.`}`,
            `➡️ ${q.rec ?? `Do ${q.title}.`}`,
            '',
            '---',
            '',
        ]),
    ].join('\n');
}

const TWO: Q[] = [
    {n: 1, title: 'Keep the API'},
    {n: 2, title: 'Store'},
];

function turn(...texts: [string, string][]): EndedTurn {
    return {texts: texts.map(([id, text]) => ({id, text}))};
}

/** A Stop whose turn posted `questions` in block `id`. */
function post(h: ReturnType<typeof harness>, id: string, questions: Q[], agents: string[] | null = null) {
    h.grill.turnEnded('s1', turn([id, roundText(questions)]), agents);
}

// ── Opening and closing ──

test('a Stop whose last block is a round opens it, the card hearing before the pending set', () => {
    /* Given */
    const h = harness();

    /* When */
    post(h, 'b1', TWO);

    /* Then */
    const view = h.view()!;
    assert.equal(view.roundId, 'b1');
    assert.equal(view.revision, 0);
    assert.equal(view.preamble, 'Here is the round.');
    assert.deepEqual(
        view.questions.map((q) => [q.number, q.title, q.answer, q.asked]),
        [
            [1, 'Keep the API', null, false],
            [2, 'Store', null, false],
        ],
    );
    assert.deepEqual(
        h.renderer.events.map((e) => e[0]),
        ['grillChanged', 'questionsAsked'],
    );
    const pending = h.renderer.only('questionsAsked')[0][1] as PendingQuestions;
    assert.equal(pending.toolUseId, 'grill-b1');
    assert.equal(pending.source, 'grill');
    assert.deepEqual(pending.questions[0], {
        question: 'Keep the API',
        header: 'Q1',
        options: [
            {label: 'Yes (Recommended)', description: 'Do Keep the API.'},
            {label: 'Wait, what?', description: ''},
        ],
        multiSelect: false,
        detail: 'Why Keep the API.',
    });
    assert.deepEqual(h.grill.views(), [view]);
});

test('a turn without a round opens nothing and tells nobody', () => {
    /* Given */
    const h = harness();

    /* When */
    h.grill.turnEnded('s1', turn(['b1', 'All done.']), null);

    /* Then */
    assert.deepEqual(h.renderer.events, []);
    assert.deepEqual(h.grill.views(), []);
});

test('a turn without a round leaves an open round open', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    h.grill.turnEnded('s1', turn(['b2', 'Still thinking.']), null);

    /* Then */
    assert.equal(h.grill.views().length, 1);
    assert.equal(h.view()!.revision, 0);
});

test('a prompt that is not an ask closes the round and drops its drafts', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});

    /* When */
    h.grill.promptSubmitted('s1', 'Actually, let us do something else');

    /* Then */
    assert.equal(h.view(), null);
    const settled = h.renderer.only('questionsSettled')[0][1] as QuestionsSettled;
    assert.deepEqual(settled, {sessionId: 's1', toolUseId: 'grill-b1', outcome: 'withdrawn'});
    assert.deepEqual(h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'}), {ok: false, error: ROUND_CLOSED});
});

test('the session ending closes the round', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    h.registry.delete('s1');
    h.prompter.exit();

    /* Then */
    assert.equal(h.view(), null);
    assert.equal(h.questions.pending().length, 0);
    assert.deepEqual(h.grill.views(), []);
});

// ── Revisions ──

test('a round posted while one is open revises it: unchanged answers stay, changed ones are set aside', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});
    h.grill.answer('s1', 'b1', 0, 1, {kind: 'overridden', text: 'Postgres'});

    /* When */
    post(h, 'b2', [
        {n: 1, title: 'Keep the API'},
        {n: 2, title: 'Store', reason: 'The agents found a second reader.'},
        {n: 3, title: 'Cache'},
    ]);

    /* Then */
    const view = h.view()!;
    assert.equal(view.roundId, 'b1', 'a revision keeps the round id');
    assert.equal(view.revision, 1);
    assert.deepEqual(
        view.questions.map((q) => [q.answer, q.setAside, q.mark]),
        [
            [{kind: 'accepted'}, null, null],
            [null, {kind: 'overridden', text: 'Postgres'}, 'changed'],
            [null, null, 'new'],
        ],
    );
    assert.equal(h.renderer.only('questionsSettled').length, 0);
    const asked = h.renderer.only('questionsAsked').map((e) => e[1] as PendingQuestions);
    assert.deepEqual(
        asked.map((p) => [p.toolUseId, p.questions.length]),
        [
            ['grill-b1', 2],
            ['grill-b1', 3],
        ],
    );
});

test('the same block again is no revision', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    post(h, 'b1', TWO);

    /* Then */
    assert.equal(h.view()!.revision, 0);
    assert.equal(h.renderer.only('questionsAsked').length, 1);
});

test('an answer given against an older revision lands on the question it became', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    post(h, 'b2', [
        {n: 1, title: 'Store'},
        {n: 2, title: 'Keep the API', reason: 'Changed.'},
    ]);

    /* When */
    const kept = h.grill.answer('s1', 'b1', 0, 1, {kind: 'accepted'});
    const changed = h.grill.answer('s1', 'b1', 0, 0, {kind: 'noted', note: 'carefully'});

    /* Then */
    assert.deepEqual([kept, changed], [{ok: true}, {ok: true}]);
    const view = h.view()!;
    assert.deepEqual(view.questions[0].answer, {kind: 'accepted'});
    assert.equal(view.questions[1].answer, null);
    assert.deepEqual(view.questions[1].setAside, {kind: 'noted', note: 'carefully'});
});

test('a call naming another round is told it is no longer open', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    const results = [
        h.grill.answer('s1', 'old', 0, 0, {kind: 'accepted'}),
        h.grill.ask('s1', 'old', 0, 0, null),
        h.grill.send('s1', 'old'),
        h.grill.queue('s1', 'old'),
        h.grill.cancelQueue('s1', 'old'),
    ];

    /* Then */
    for (const result of results) assert.deepEqual(result, {ok: false, error: ROUND_CLOSED});
});

// ── Asks ──

test('an ask is typed in, and its prompt coming back marks the question asked', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    const result = h.grill.ask('s1', 'b1', 0, 1, 'why not files?');
    h.grill.promptSubmitted('s1', 'Before I answer the round, about Q2: why not files?');

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(h.prompter.sent, [['s1', 'Before I answer the round, about Q2: why not files?']]);
    const view = h.view()!;
    assert.equal(view.questions[1].asked, true);
    assert.equal(view.asking, 1);
    assert.equal(h.questions.pending().length, 1, 'the round stays open');
});

test("the ask's turn becomes the question's explanation", () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.ask('s1', 'b1', 0, 0, null);
    h.grill.promptSubmitted('s1', '/wait-what Q1');

    /* When */
    h.grill.turnEnded('s1', turn(['e1', 'In plain words:'], ['e2', 'it has two callers.']), null);

    /* Then */
    const view = h.view()!;
    assert.equal(view.asking, null);
    assert.equal(view.questions[0].explanation, 'In plain words:\n\nit has two callers.');
    assert.equal(view.revision, 0);
});

test('an ask typed by hand is known by its wording', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    h.grill.promptSubmitted('s1', '/wait-what Q2');

    /* Then */
    assert.equal(h.view()!.asking, 1);
    assert.equal(h.questions.pending().length, 1);
});

test('an ask about a number the round does not have is a reply', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    h.grill.promptSubmitted('s1', '/wait-what Q9');

    /* Then */
    assert.equal(h.view(), null);
});

test('an ask whose turn posts the whole round again is a revision, not an explanation', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.ask('s1', 'b1', 0, 0, 'really?');
    h.grill.promptSubmitted('s1', 'Before I answer the round, about Q1: really?');

    /* When */
    post(h, 'b2', [
        {n: 1, title: 'Keep the API', rec: 'Drop it after all.'},
        {n: 2, title: 'Store'},
    ]);

    /* Then */
    const view = h.view()!;
    assert.equal(view.revision, 1);
    assert.equal(view.questions[0].mark, 'changed');
    assert.equal(view.questions[0].explanation, null);
    assert.equal(view.questions[0].asked, true, 'asked follows the question');
});

test('an ask while Claude is busy is refused', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.prompter.setBusy(true);

    /* When */
    const result = h.grill.ask('s1', 'b1', 0, 0, null);

    /* Then */
    assert.deepEqual(result, {ok: false, error: BUSY_ASK});
    assert.deepEqual(h.prompter.sent, []);
});

// ── Send ──

test('send types the answers in and closes the round as answered, before the prompt echoes', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});
    h.grill.answer('s1', 'b1', 0, 1, {kind: 'noted', note: 'SQLite'});

    /* When */
    const result = h.grill.send('s1', 'b1', 'phone');
    h.grill.promptSubmitted('s1', 'Q1: yes\nQ2: yes, note: SQLite');

    /* Then */
    assert.deepEqual(result, {ok: true});
    assert.deepEqual(h.prompter.sent, [['s1', 'Q1: yes\nQ2: yes, note: SQLite']]);
    const settled = h.renderer.only('questionsSettled').map((e) => e[1] as QuestionsSettled);
    assert.deepEqual(settled, [{sessionId: 's1', toolUseId: 'grill-b1', outcome: 'answered', answeredOn: 'phone'}]);
    assert.equal(h.view(), null);
    const kinds = h.renderer.events.map((e) => e[0]);
    assert.ok(kinds.lastIndexOf('grillChanged') < kinds.lastIndexOf('questionsSettled'));
});

test('send with nothing answered, or while Claude is busy, is refused', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    const empty = h.grill.send('s1', 'b1');
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});
    h.prompter.setBusy(true);
    const busy = h.grill.send('s1', 'b1');

    /* Then */
    assert.deepEqual(empty, {ok: false, error: ANSWER_FIRST});
    assert.deepEqual(busy, {ok: false, error: BUSY_SEND});
    assert.deepEqual(h.prompter.sent, []);
    assert.equal(h.grill.views().length, 1);
});

// ── Agents and the queued send ──

test('agents are counted by id; a stop for an unknown agent is ignored', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);

    /* When */
    h.grill.subagentChanged('s1', 'start', 'a1');
    h.grill.subagentChanged('s1', 'start', 'a2');
    h.grill.subagentChanged('s1', 'stop', 'stranger');
    h.grill.subagentChanged('s1', 'stop', 'a1');

    /* Then */
    assert.equal(h.view()!.agentsRunning, 1);
});

test("a Stop's background agents replace what the hooks counted", () => {
    /* Given */
    const h = harness();
    h.grill.subagentChanged('s1', 'start', 'a1');

    /* When */
    post(h, 'b1', TWO, ['x1', 'x2', 'x3']);

    /* Then */
    assert.equal(h.view()!.agentsRunning, 3);
});

test('a queued send waits for the agents to stop and then for Claude to stop', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO, ['a1']);
    h.grill.subagentChanged('s1', 'start', 'a1');
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});

    /* When */
    const queued = h.grill.queue('s1', 'b1');
    h.grill.subagentChanged('s1', 'stop', 'a1');
    const afterAgents = h.prompter.sent.length;
    h.grill.turnEnded('s1', turn(['b9', 'The agents are back; nothing changes.']), []);

    /* Then */
    assert.deepEqual(queued, {ok: true});
    assert.equal(afterAgents, 0, 'not sent while Claude has not stopped since');
    assert.deepEqual(h.prompter.sent, [['s1', 'Q1: yes']]);
    assert.equal(h.view(), null);
});

test('a queued send that is due while Claude is busy goes in when it is idle', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});
    h.prompter.setBusy(true);

    /* When */
    h.grill.queue('s1', 'b1');
    const whileBusy = h.prompter.sent.length;
    h.prompter.setBusy(false);
    h.prompter.idle();

    /* Then */
    assert.equal(whileBusy, 0);
    assert.deepEqual(h.prompter.sent, [['s1', 'Q1: yes']]);
    assert.equal(h.prompter.watchingIdle(), 0);
});

test('queuing needs an answer, and cancelling takes the send back', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.subagentChanged('s1', 'start', 'a1');

    /* When */
    const empty = h.grill.queue('s1', 'b1');
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});
    h.grill.queue('s1', 'b1');
    const queued = h.view()!.send;
    h.grill.cancelQueue('s1', 'b1');

    /* Then */
    assert.deepEqual(empty, {ok: false, error: ANSWER_FIRST});
    assert.equal(queued, 'queued');
    assert.equal(h.view()!.send, 'idle');
});

test('a revision while queued cancels the send and says so', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO, ['a1']);
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});
    h.grill.queue('s1', 'b1');

    /* When */
    post(h, 'b2', [...TWO, {n: 3, title: 'Cache'}], []);

    /* Then */
    assert.equal(h.view()!.send, 'unsent');
    assert.deepEqual(h.prompter.sent, []);
});

test('a queued send waits while an ask is under way', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});
    h.grill.ask('s1', 'b1', 0, 1, null);
    h.grill.promptSubmitted('s1', '/wait-what Q2');
    h.prompter.sent.length = 0;

    /* When */
    h.grill.queue('s1', 'b1');
    const duringAsk = h.prompter.sent.length;
    h.grill.turnEnded('s1', turn(['e1', 'It means the store.']), []);

    /* Then */
    assert.equal(duringAsk, 0);
    assert.deepEqual(h.prompter.sent, [['s1', 'Q1: yes']]);
});

test('a re-keyed session is reported under its new id and answerable under either', () => {
    /* Given */
    const h = harness();
    post(h, 'b1', TWO);
    h.registry.rekey('s1', 'real-1');

    /* When */
    const result = h.grill.answer('s1', 'b1', 0, 0, {kind: 'accepted'});

    /* Then */
    assert.deepEqual(result, {ok: true});
    const last = h.renderer.only('grillChanged').at(-1)![1] as GrillChanged;
    assert.equal(last.sessionId, 'real-1');
    assert.equal(last.view!.sessionId, 'real-1');
});

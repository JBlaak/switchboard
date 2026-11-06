import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grillReducer, grillUiFor, initialGrillState, rekeyGrill} from '../src/renderer/state/grill-slice';
import {withInFlight} from '../src/renderer/features/grill/grill-ui';
import {question, view} from './support/grill-views';
import type {GrillState} from '../src/renderer/state/grill-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {GrillView} from '../src/domain/grill/model';
import type {InFlightAnswer} from '../src/renderer/features/grill/grill-ui';

function run(state: GrillState, ...events: RendererEvent[]): GrillState {
    return events.reduce((s, e) => grillReducer(s, e), state);
}

const changed = (v: GrillView | null, sessionId = 's1'): RendererEvent => ({
    type: 'grillChanged',
    changed: {sessionId, view: v},
});

const at = {sessionId: 's1', roundId: 'r1'};

function sent(over: Partial<InFlightAnswer> = {}): RendererEvent {
    return {
        type: 'grillAnswerSent',
        sessionId: 's1',
        entry: {seq: 1, roundId: 'r1', revision: 0, place: 0, answer: {kind: 'accepted'}, settled: false, ...over},
    };
}

/** The view the card would draw for s1. */
const shown = (state: GrillState) => withInFlight(state.views.s1!, state.inFlight.s1 ?? []);

// ── Views ──

test('a change files the round under its session', () => {
    /* When */
    const state = run(initialGrillState, changed(view(2)));

    /* Then */
    assert.equal(state.views.s1?.roundId, 'r1');
});

test('a round closing drops it with its working state and calls', () => {
    /* Given */
    const open = run(initialGrillState, changed(view(2)), {type: 'grillNavigated', ...at, place: 1}, sent());

    /* When */
    const state = run(open, changed(null));

    /* Then */
    assert.deepEqual([state.views.s1, state.ui.s1, state.inFlight.s1], [undefined, undefined, undefined]);
});

test('the start-up fetch does not bring back a round that closed meanwhile, nor replace a newer one', () => {
    /* Given */
    const state = run(
        initialGrillState,
        changed(view(1)),
        changed(null),
        changed(view(1, {sessionId: 's2', roundId: 'r2', revision: 1}), 's2'),
    );

    /* When */
    const loaded = run(state, {
        type: 'grillLoaded',
        views: [view(1), view(1, {sessionId: 's2', roundId: 'r2', revision: 0})],
    });

    /* Then */
    assert.equal(loaded.views.s1, undefined);
    assert.equal(loaded.views.s2?.revision, 1);
});

test('the start-up fetch fills in rounds not yet known', () => {
    /* When */
    const state = run(initialGrillState, {type: 'grillLoaded', views: [view(3)]});

    /* Then */
    assert.equal(state.views.s1?.questions.length, 3);
});

// ── Working state ──

test('a round the card has not touched starts on its first question with the context open', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2)));

    /* When */
    const ui = grillUiFor(state, 's1');

    /* Then */
    assert.deepEqual(ui && {place: ui.place, contextOpen: ui.contextOpen, fields: ui.fields}, {
        place: 0,
        contextOpen: true,
        fields: {},
    });
});

test('the place, open fields and folded context survive further snapshots of the round', () => {
    /* Given */
    const state = run(
        initialGrillState,
        changed(view(3)),
        {type: 'grillNavigated', ...at, place: 2},
        {type: 'grillFieldOpened', ...at, place: 2, field: {kind: 'note', text: ''}},
        {type: 'grillFieldTyped', ...at, place: 2, text: 'half'},
        {type: 'grillContextToggled', ...at, open: false},
    );

    /* When */
    const next = run(state, changed(view(3, {agentsRunning: 1})));

    /* Then */
    const ui = grillUiFor(next, 's1')!;
    assert.deepEqual([ui.place, ui.fields, ui.contextOpen], [2, {2: {kind: 'note', text: 'half'}}, false]);
});

test('a field stays open with its text while the card looks at another question', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(3)), {
        type: 'grillFieldOpened',
        ...at,
        place: 0,
        field: {kind: 'override', text: 'mine'},
    });

    /* When */
    const next = run(state, {type: 'grillNavigated', ...at, place: 2}, {type: 'grillNavigated', ...at, place: 0});

    /* Then */
    assert.deepEqual(grillUiFor(next, 's1')!.fields, {0: {kind: 'override', text: 'mine'}});
});

test('closing a field drops it and its text', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(1)), {
        type: 'grillFieldOpened',
        ...at,
        place: 0,
        field: {kind: 'ask', text: 'why'},
    });

    /* When */
    const next = run(state, {type: 'grillFieldClosed', ...at, place: 0});

    /* Then */
    assert.deepEqual(grillUiFor(next, 's1')!.fields, {});
});

test('another round for the session starts its working state over', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(3)), {type: 'grillNavigated', ...at, place: 2});

    /* When */
    const next = run(state, changed(view(2, {roundId: 'r2'})));

    /* Then */
    assert.equal(grillUiFor(next, 's1')!.place, 0);
});

test('working-state events for a round that is no longer the session one do nothing', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2, {roundId: 'r2'})));

    /* When */
    const next = run(state, {type: 'grillNavigated', ...at, place: 1});

    /* Then */
    assert.strictEqual(next, state);
});

test('a revision moves the place along with its question', () => {
    /* Given */
    const first = view(0, {questions: [question(1, {title: 'A'}), question(2, {title: 'B'})]});
    const state = run(initialGrillState, changed(first), {type: 'grillNavigated', ...at, place: 1});
    const revised = view(0, {
        revision: 1,
        questions: [question(1, {title: 'New', mark: 'new'}), question(2, {title: 'A'}), question(3, {title: 'B'})],
    });

    /* When */
    const next = run(state, changed(revised));

    /* Then */
    assert.equal(grillUiFor(next, 's1')!.place, 2);
});

test('the banner remembers what was seen and dismissed for its revision', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2, {revision: 1})));

    /* When */
    const next = run(
        state,
        {type: 'grillSeen', ...at, revision: 1, place: 1},
        {type: 'grillBannerDismissed', ...at, revision: 1},
    );

    /* Then */
    assert.deepEqual(grillUiFor(next, 's1')!.banner, {revision: 1, dismissed: true, seen: [1]});
});

test('an error is kept until cleared', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(1)), {type: 'grillError', ...at, error: 'Claude is busy'});

    /* When */
    const cleared = run(state, {type: 'grillError', ...at, error: null});

    /* Then */
    assert.equal(grillUiFor(state, 's1')!.error, 'Claude is busy');
    assert.equal(grillUiFor(cleared, 's1')!.error, null);
});

// ── Answers in flight ──

test('an answer shows as soon as it is sent', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2)));

    /* When */
    const next = run(state, sent({place: 1}));

    /* Then */
    assert.deepEqual(shown(next).questions[1]!.answer, {kind: 'accepted'});
});

test('an older snapshot does not take an answer in flight away', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2)), sent({place: 1}));

    /* When */
    const next = run(state, changed(view(2, {agentsRunning: 1})));

    /* Then */
    assert.deepEqual(shown(next).questions[1]!.answer, {kind: 'accepted'});
});

test('a call that failed takes its answer back', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2)), sent({place: 1}));

    /* When */
    const next = run(state, {type: 'grillAnswerSettled', sessionId: 's1', seq: 1, ok: false});

    /* Then */
    assert.equal(shown(next).questions[1]!.answer, null);
    assert.equal(next.inFlight.s1, undefined);
});

test('a call that went through before its snapshot keeps its answer until the snapshot comes', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2)), sent({place: 1}));

    /* When */
    const settled = run(state, {type: 'grillAnswerSettled', sessionId: 's1', seq: 1, ok: true});
    const answered = view(2);
    answered.questions[1] = question(2, {answer: {kind: 'accepted'}});
    const snapshot = run(settled, changed(answered));

    /* Then */
    assert.deepEqual(shown(settled).questions[1]!.answer, {kind: 'accepted'});
    assert.equal(snapshot.inFlight.s1, undefined);
    assert.deepEqual(shown(snapshot).questions[1]!.answer, {kind: 'accepted'});
});

test('a call that went through after its snapshot is done at once', () => {
    /* Given */
    const answered = view(2);
    answered.questions[1] = question(2, {answer: {kind: 'accepted'}});
    const state = run(initialGrillState, changed(view(2)), sent({place: 1}), changed(answered));

    /* When */
    const next = run(state, {type: 'grillAnswerSettled', sessionId: 's1', seq: 1, ok: true});

    /* Then */
    assert.equal(next.inFlight.s1, undefined);
});

// ── Re-keys ──

test('a re-keyed session keeps its round, working state and calls under the new id', () => {
    /* Given */
    const state = run(initialGrillState, changed(view(2)), {type: 'grillNavigated', ...at, place: 1}, sent());

    /* When */
    const next = rekeyGrill(state, 's1', 's2');

    /* Then */
    assert.equal(next.views.s2?.sessionId, 's2');
    assert.equal(next.ui.s2?.place, 1);
    assert.equal(next.inFlight.s2?.length, 1);
    assert.equal(next.views.s1, undefined);
});

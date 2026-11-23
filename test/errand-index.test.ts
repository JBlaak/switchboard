/** The renderer's errand index: which pushes change what the session list shows of errands. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer, type RendererState} from '../src/renderer/state/root';
import {errandOf, errandsChanged} from '../src/renderer/state/errand-index';
import {EMPTY_INBOX_SUMMARY, type TriageErrandView} from '../src/domain/inbox/model';
import {facts, run, schedule} from './support/schedule-shelf-fixtures';

const TRIAGE: TriageErrandView = {
    sessionId: 't-1',
    key: 'bugsnag:proj:err-1',
    title: 'TypeError: x is undefined',
    repository: 'movelab/switchboard',
    needsYou: false,
};

/** The state after main pushed an inbox summary triaging `triaging`, with `unread` bugs. */
function triaging(state: RendererState, views: readonly TriageErrandView[], unread = 0): RendererState {
    const summary = {...EMPTY_INBOX_SUMMARY, bug: {unread, urgent: 0}, triaging: views};
    return rootReducer(state, {type: 'inboxChanged', summary});
}

test('a triage starting is an errands change, and its session is then an errand', () => {
    /* Given */
    const previous = initialRendererState();

    /* When */
    const state = triaging(previous, [TRIAGE]);

    /* Then */
    assert.equal(errandsChanged(previous, state), true);
    assert.equal(errandOf(state, 't-1')?.kind, 'triage');
});

test('a triage that comes to need you is an errands change', () => {
    /* Given */
    const previous = triaging(initialRendererState(), [TRIAGE]);

    /* When */
    const state = triaging(previous, [{...TRIAGE, needsYou: true}]);

    /* Then */
    assert.equal(errandsChanged(previous, state), true);
    assert.equal(errandOf(state, 't-1')?.needsYou, true);
});

test('a triage finishing is an errands change', () => {
    /* Given */
    const previous = triaging(initialRendererState(), [TRIAGE]);

    /* When */
    const state = triaging(previous, []);

    /* Then */
    assert.equal(errandsChanged(previous, state), true);
    assert.equal(errandOf(state, 't-1'), null);
});

test('a push that only changes the counts leaves the errands as they were', () => {
    /* Given */
    const previous = triaging(initialRendererState(), [TRIAGE]);

    /* When */
    const state = triaging(previous, [{...TRIAGE}], 4);

    /* Then */
    assert.equal(errandsChanged(previous, state), false);
});

// ── Scheduled runs ──

/** The state after main pushed the Schedule manager's facts. */
function scheduled(state: RendererState, runs: Parameters<typeof facts>[1]): RendererState {
    return rootReducer(state, {type: 'scheduleManagerChanged', facts: facts([schedule('sweep')], runs)});
}

test('a scheduled run starting is an errands change, and its session is then an errand', () => {
    /* Given */
    const previous = initialRendererState();

    /* When */
    const state = scheduled(previous, [run('r-1', 'sweep', {status: 'running', endedAt: null})]);

    /* Then */
    assert.equal(errandsChanged(previous, state), true);
    assert.equal(errandOf(state, 's-r-1')?.kind, 'scheduled');
});

test('a scheduled run being seen is an errands change, and its session is the user’s again', () => {
    /* Given */
    const previous = scheduled(initialRendererState(), [run('r-1', 'sweep')]);

    /* When */
    const state = scheduled(previous, [run('r-1', 'sweep', {seen: true})]);

    /* Then */
    assert.equal(errandsChanged(previous, state), true);
    assert.equal(errandOf(state, 's-r-1'), null);
});

test('a schedule push that leaves the runs as they were is no errands change', () => {
    /* Given */
    const previous = scheduled(initialRendererState(), [run('r-1', 'sweep')]);

    /* When */
    const state = scheduled(previous, [run('r-1', 'sweep', {weekAfter: 12})]);

    /* Then */
    assert.equal(errandsChanged(previous, state), false);
});

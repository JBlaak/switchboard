/** The renderer's errand index: which pushes change what the session list shows of errands. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer, type RendererState} from '../src/renderer/state/root';
import {errandOf, errandsChanged} from '../src/renderer/state/errand-index';
import {EMPTY_INBOX_SUMMARY, type TriageErrandView} from '../src/domain/inbox/model';

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

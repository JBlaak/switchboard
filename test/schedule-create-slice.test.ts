/**
 * The create-a-schedule dialog's state: opening it (blank or from a session),
 * drafting, the form, Back, and saving; answers for an earlier opening are
 * dropped.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialScheduleCreateState, scheduleCreateReducer} from '../src/renderer/state/schedule-create-slice';
import {dialogReducer, initialDialogState} from '../src/renderer/state/dialog-slice';
import {blankScheduleSettings} from '../src/domain/schedule/form';
import type {ScheduleCreateState} from '../src/renderer/state/schedule-create-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {ScheduleSettings} from '../src/domain/schedule/manager';

const SETTINGS: ScheduleSettings = {
    ...blankScheduleSettings('/Users/me/code/app'),
    name: 'Bugsnag sweep',
    slug: 'bugsnag-sweep',
    prompt: 'Look at new errors.',
};

function run(state: ScheduleCreateState, ...events: RendererEvent[]): ScheduleCreateState {
    return events.reduce(scheduleCreateReducer, state);
}

const opened = (sessionId: string | null = null): RendererEvent => ({type: 'scheduleCreateRequested', sessionId});
const drafted = (request: number): RendererEvent => ({
    type: 'scheduleCreateDrafted',
    request,
    result: {draft: {settings: SETTINGS, whenReason: '"every night"'}},
});

// ── Opening ──

test('asking for the create form opens the dialog', () => {
    /* When */
    const state = dialogReducer(initialDialogState, opened());

    /* Then */
    assert.deepEqual(state, {open: {kind: 'createSchedule'}, seq: 1});
});

test('a blank opening starts on step 1 with nothing typed', () => {
    /* Given */
    const used = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateSentenceTyped', text: 'old'});

    /* When */
    const state = run(used, opened());

    /* Then */
    assert.deepEqual(state, {...initialScheduleCreateState, request: 2});
});

test('opening from a session skips the sentence and drafts at once', () => {
    /* When */
    const state = run(initialScheduleCreateState, opened('s1'));

    /* Then */
    assert.equal(state.fromSession, 's1');
    assert.equal(state.busy, 'drafting');
});

// ── Drafting ──

test('Draft it waits on Claude and keeps the sentence', () => {
    /* Given */
    const typed = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateSentenceTyped', text: 'Every night'});

    /* When */
    const state = run(typed, {type: 'scheduleCreateDraftAsked'});

    /* Then */
    assert.equal(state.busy, 'drafting');
    assert.equal(state.sentence, 'Every night');
});

test('a draft opens step 2 with its settings and the reason for its time', () => {
    /* Given */
    const asked = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateDraftAsked'});

    /* When */
    const state = run(asked, drafted(asked.request));

    /* Then */
    assert.equal(state.step, 'review');
    assert.equal(state.busy, null);
    assert.equal(state.settings, SETTINGS);
    assert.equal(state.whenReason, '"every night"');
});

test('a failed draft says why on step 1 and keeps the sentence', () => {
    /* Given */
    const asked = run(
        initialScheduleCreateState,
        opened(),
        {type: 'scheduleCreateSentenceTyped', text: 'Every night'},
        {type: 'scheduleCreateDraftAsked'},
    );

    /* When */
    const state = run(asked, {
        type: 'scheduleCreateDrafted',
        request: asked.request,
        result: {error: 'Claude timed out'},
    });

    /* Then */
    assert.equal(state.step, 'describe');
    assert.equal(state.busy, null);
    assert.equal(state.error, 'Claude timed out');
    assert.equal(state.sentence, 'Every night');
});

test('a draft for an earlier opening is dropped', () => {
    /* Given */
    const first = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateDraftAsked'});
    const second = run(first, opened(), {type: 'scheduleCreateDraftAsked'});

    /* When */
    const state = run(second, drafted(first.request));

    /* Then */
    assert.equal(state, second);
});

test('asking for a draft again while one is coming does nothing', () => {
    /* Given */
    const asked = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateDraftAsked'});

    /* When */
    const state = run(asked, {type: 'scheduleCreateDraftAsked'});

    /* Then */
    assert.equal(state, asked);
});

// ── The form ──

test('Write it myself opens step 2 on the settings given, with no reason', () => {
    /* When */
    const state = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateReviewOpened', settings: SETTINGS});

    /* Then */
    assert.equal(state.step, 'review');
    assert.equal(state.settings, SETTINGS);
    assert.equal(state.whenReason, null);
});

test('edits on the form replace its settings', () => {
    /* Given */
    const review = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateReviewOpened', settings: SETTINGS});
    const edited = {...SETTINGS, name: 'Nightly sweep'};

    /* When */
    const state = run(review, {type: 'scheduleCreateSettingsEdited', settings: edited});

    /* Then */
    assert.equal(state.settings, edited);
});

test('Back goes to step 1 with the sentence kept and the session let go', () => {
    /* Given */
    const fromSession = run(initialScheduleCreateState, opened('s1'));
    const review = run(fromSession, drafted(fromSession.request));

    /* When */
    const state = run(review, {type: 'scheduleCreateBack'});

    /* Then */
    assert.equal(state.step, 'describe');
    assert.equal(state.fromSession, null);
});

// ── Saving ──

test('a save waits, then a failure says why on the form', () => {
    /* Given */
    const review = run(initialScheduleCreateState, opened(), {type: 'scheduleCreateReviewOpened', settings: SETTINGS});
    const saving = run(review, {type: 'scheduleCreateSaveAsked'});

    /* When */
    const state = run(saving, {type: 'scheduleCreateSaved', request: saving.request, result: {error: 'File exists'}});

    /* Then */
    assert.equal(saving.busy, 'saving');
    assert.equal(state.busy, null);
    assert.equal(state.error, 'File exists');
    assert.equal(state.step, 'review');
});

test('Back is refused while a save is on its way', () => {
    /* Given */
    const saving = run(
        initialScheduleCreateState,
        opened(),
        {type: 'scheduleCreateReviewOpened', settings: SETTINGS},
        {type: 'scheduleCreateSaveAsked'},
    );

    /* When */
    const state = run(saving, {type: 'scheduleCreateBack'});

    /* Then */
    assert.equal(state, saving);
});

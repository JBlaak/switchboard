/** The Schedule manager's renderer slice: the facts main pushed, and its page's own state. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    initialScheduleManagerState,
    promptEdited,
    promptShown,
    scheduleManagerReducer,
    type ScheduleManagerSliceState,
} from '../src/renderer/state/schedule-manager-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import {detail, facts, run, settings, summary} from './support/schedule-fixtures';

const KEY = '/p/.claude/commands/schedule-a.md';

function reduce(state: ScheduleManagerSliceState, ...events: RendererEvent[]): ScheduleManagerSliceState {
    return events.reduce((s, e) => scheduleManagerReducer(Object.freeze(s), e), state);
}

const opened = (): ScheduleManagerSliceState =>
    reduce(
        initialScheduleManagerState,
        {type: 'scheduleManagerPageRequested', key: KEY},
        {type: 'scheduleDetailLoaded', key: KEY, detail: detail({runs: [run('new'), run('old')]})},
    );

test('a push replaces the facts and leaves the page as it was', () => {
    /* Given */
    const pushed = facts({schedules: [summary('a')]});

    /* When */
    const next = reduce(initialScheduleManagerState, {type: 'scheduleManagerChanged', facts: pushed});

    /* Then */
    assert.equal(next.facts, pushed);
    assert.equal(next.page, initialScheduleManagerState.page);
});

test("opening a schedule's page chooses it, and its detail chooses its newest run", () => {
    /* When */
    const state = opened();

    /* Then */
    assert.equal(state.page.openKey, KEY);
    assert.equal(state.page.selected, KEY);
    assert.equal(state.page.detail?.runs.length, 2);
    assert.equal(state.page.selectedRun, 'new');
    assert.equal(state.page.expandedRun, null);
});

test('a detail for a schedule no longer open is dropped', () => {
    /* Given */
    const state = reduce(initialScheduleManagerState, {type: 'scheduleManagerPageRequested', key: KEY});

    /* When */
    const next = reduce(state, {type: 'scheduleDetailLoaded', key: '/other.md', detail: detail()});

    /* Then */
    assert.equal(next, state);
});

test('Open run unfolds that run before the detail comes, and the detail keeps it', () => {
    /* When */
    const state = reduce(
        initialScheduleManagerState,
        {type: 'scheduleManagerPageRequested', key: KEY},
        {type: 'scheduleRunToggled', runId: 'old', open: true},
        {type: 'scheduleDetailLoaded', key: KEY, detail: detail({runs: [run('new'), run('old')]})},
    );

    /* Then */
    assert.equal(state.page.selectedRun, 'old');
    assert.equal(state.page.expandedRun, 'old');
});

test('a run unfolds on toggle and folds on the next', () => {
    /* When */
    const unfolded = reduce(opened(), {type: 'scheduleRunToggled', runId: 'old'});
    const folded = reduce(unfolded, {type: 'scheduleRunToggled', runId: 'old'});

    /* Then */
    assert.equal(unfolded.page.expandedRun, 'old');
    assert.equal(folded.page.expandedRun, null);
    assert.equal(folded.page.selectedRun, 'old');
});

test('a run gone from a fresh detail is let go', () => {
    /* Given */
    const state = reduce(opened(), {type: 'scheduleRunToggled', runId: 'old'});

    /* When */
    const next = reduce(state, {type: 'scheduleDetailLoaded', key: KEY, detail: detail({runs: [run('new')]})});

    /* Then */
    assert.equal(next.page.expandedRun, null);
    assert.equal(next.page.selectedRun, 'new');
});

test('the prompt typed is shown until it is reset, and only a change counts as an edit', () => {
    /* Given */
    const saved = detail({summary: summary(KEY, {}, {prompt: 'saved'})});
    const state = reduce(
        initialScheduleManagerState,
        {type: 'scheduleManagerPageRequested', key: KEY},
        {
            type: 'scheduleDetailLoaded',
            key: KEY,
            detail: saved,
        },
    );

    /* When */
    const same = reduce(state, {type: 'schedulePromptTyped', text: 'saved'});
    const typed = reduce(
        state,
        {type: 'schedulePromptTyped', text: 'better'},
        {type: 'schedulePromptNoteTyped', note: 'why'},
    );
    const reset = reduce(typed, {type: 'schedulePromptReset'});

    /* Then */
    assert.equal(promptShown(state.page), 'saved');
    assert.equal(promptEdited(same.page), false);
    assert.equal(promptShown(typed.page), 'better');
    assert.equal(promptEdited(typed.page), true);
    assert.equal(typed.page.promptNote, 'why');
    assert.equal(promptShown(reset.page), 'saved');
    assert.equal(reset.page.promptNote, '');
});

test('back on the overview, what was typed on the page goes and the schedule stays chosen', () => {
    /* Given */
    const state = reduce(
        opened(),
        {type: 'schedulePromptTyped', text: 'half done'},
        {type: 'scheduleSettingsOpened', settings: settings()},
        {type: 'scheduleManagerNoticed', notice: 'Saved.'},
    );

    /* When */
    const next = reduce(state, {type: 'scheduleManagerPageRequested', key: null});

    /* Then */
    assert.equal(next.page.openKey, null);
    assert.equal(next.page.selected, KEY);
    assert.equal(next.page.detail, null);
    assert.equal(next.page.promptDraft, null);
    assert.equal(next.page.settingsDraft, null);
    assert.equal(next.page.notice, null);
});

test('the settings sheet holds its copy while open, and lets it go on close', () => {
    /* Given */
    const state = reduce(opened(), {type: 'scheduleSettingsOpened', settings: settings()});

    /* When */
    const edited = reduce(state, {type: 'scheduleSettingsEdited', settings: settings({cron: '0 4 * * *'})});
    const closed = reduce(edited, {type: 'scheduleSettingsClosed'});

    /* Then */
    assert.equal(edited.page.settingsDraft?.cron, '0 4 * * *');
    assert.equal(closed.page.settingsDraft, null);
});

test('busy, the notice, Paused shown and the row chosen are kept as told', () => {
    /* When */
    const state = reduce(
        initialScheduleManagerState,
        {type: 'scheduleManagerBusy', what: 'runNow'},
        {type: 'scheduleManagerNoticed', notice: 'Running.'},
        {type: 'schedulePausedShown', shown: true},
        {type: 'scheduleRowSelected', key: 'b'},
    );

    /* Then */
    assert.equal(state.page.busy, 'runNow');
    assert.equal(state.page.notice, 'Running.');
    assert.equal(state.page.showPaused, true);
    assert.equal(state.page.selected, 'b');
});

test('any other event leaves the slice as it was', () => {
    /* When */
    const next = scheduleManagerReducer(initialScheduleManagerState, {type: 'sessionArchived', sessionId: 's1'});

    /* Then */
    assert.strictEqual(next, initialScheduleManagerState);
});

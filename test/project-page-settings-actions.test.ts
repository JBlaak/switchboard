/**
 * A project page's settings view (#176) against a fake `window.api`: a change
 * there is written over the blob as stored now, so what else keeps in it,
 * like the project's saved prompts (#344), survives.
 */
import {beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatch} from '../src/renderer/state/app-store';
import {
    changeProjectSetting,
    resetProjectSettings,
    setReleasesTagged,
    setWatchIssues,
} from '../src/renderer/ui/project-page/settings-actions';
import {projectSettingsKey} from '../src/domain/settings/settings';

const APP = '/Users/me/code/app';
const KEY = projectSettingsKey(APP);
const PROMPTS = [{id: 'p1', label: 'Rebuild', text: 'Rebuild and restart', mode: 'send'}];

/** A main with a settings store; records every write. */
function installMain(stored: Record<string, unknown>): {writes: [string, unknown][]} {
    const writes: [string, unknown][] = [];
    const api = {
        getSetting: async (key: string) => stored[key] ?? null,
        setSetting: async (key: string, value: unknown) => {
            stored[key] = value;
            writes.push([key, value]);
        },
    };
    Object.assign(globalThis, {window: {api}});
    return {writes};
}

beforeEach(() => {
    /* The view opened before any prompt was saved for the project. */
    dispatch({type: 'projectSettingsLoaded', projectPath: APP, current: {worktree: true}, globalSettings: {}});
});

test('changing a project setting keeps the prompts saved since the view opened', async () => {
    /* Given */
    const main = installMain({[KEY]: {worktree: true, savedPrompts: PROMPTS}});

    /* When */
    await changeProjectSetting(APP, 'chrome', true);

    /* Then */
    assert.deepEqual(main.writes, [[KEY, {worktree: true, chrome: true, savedPrompts: PROMPTS}]]);
});

test('resetting to the global settings keeps the project’s saved prompts', async () => {
    /* Given */
    const main = installMain({[KEY]: {worktree: true, savedPrompts: PROMPTS}});

    /* When */
    await resetProjectSettings(APP);

    /* Then */
    assert.deepEqual(main.writes, [[KEY, {savedPrompts: PROMPTS}]]);
});

test('switching Watch issues on from the page keeps the rest of the project’s blob', async () => {
    /* Given */
    const main = installMain({[KEY]: {worktree: true, savedPrompts: PROMPTS}});

    /* When */
    await setWatchIssues(APP, true);

    /* Then */
    assert.deepEqual(main.writes, [[KEY, {worktree: true, savedPrompts: PROMPTS, watchIssues: true}]]);
});

test('Watch issues is written for a project whose settings view is not open', async () => {
    /* Given */
    const OTHER = '/Users/me/code/other';
    const main = installMain({});

    /* When */
    await setWatchIssues(OTHER, true);

    /* Then */
    assert.deepEqual(main.writes, [[projectSettingsKey(OTHER), {watchIssues: true}]]);
});

test('setting Releases are tagged back to detected drops the project’s say', async () => {
    /* Given */
    const main = installMain({[KEY]: {releasesTagged: false, chrome: true}});

    /* When */
    await setReleasesTagged(APP, null);

    /* Then */
    assert.deepEqual(main.writes, [[KEY, {chrome: true}]]);
});

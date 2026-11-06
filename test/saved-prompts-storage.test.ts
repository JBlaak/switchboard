/**
 * Saved prompts (#339) in the settings blobs: the global list and a project's,
 * written without touching the blobs' other keys, and read back as stored
 * (which is what survives a restart: the store is the sqlite settings table).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SettingsService} from '../src/application/services/settings-service';
import type {SettingsStore} from '../src/application/ports/settings-store';
import type {SavedPrompt} from '../src/domain/settings/saved-prompts';

class MemoryStore implements SettingsStore {
    public readonly values = new Map<string, unknown>();
    public get<T>(key: string): T | null {
        return (this.values.has(key) ? structuredClone(this.values.get(key)) : null) as T | null;
    }
    public set(key: string, value: unknown): void {
        this.values.set(key, structuredClone(value));
    }
    public delete(key: string): void {
        this.values.delete(key);
    }
}

const PROJECT = '/code/app';
const ask: SavedPrompt = {id: 'g1', label: 'Where are we?', text: 'Where are we?', mode: 'send'};
const rebase: SavedPrompt = {id: 'p1', label: 'Rebase', text: 'Rebase {branch} on main', mode: 'input'};

test('the global list is stored in the global blob, beside its other keys', () => {
    /* Given */
    const store = new MemoryStore();
    store.set('global', {quickAsk: false});
    const settings = new SettingsService(store);

    /* When */
    settings.setSavedPrompts(null, [ask]);

    /* Then */
    assert.deepEqual(store.get('global'), {quickAsk: false, savedPrompts: [ask]});
});

test('a project’s list is stored in its own blob, beside its overrides', () => {
    /* Given */
    const store = new MemoryStore();
    store.set('project:' + PROJECT, {worktree: true});
    const settings = new SettingsService(store);

    /* When */
    settings.setSavedPrompts(PROJECT, [rebase]);

    /* Then */
    assert.deepEqual(store.get('project:' + PROJECT), {worktree: true, savedPrompts: [rebase]});
});

test('both lists read back for a project, as a new service over the same store reads them', () => {
    /* Given */
    const store = new MemoryStore();
    new SettingsService(store).setSavedPrompts(null, [ask]);
    new SettingsService(store).setSavedPrompts(PROJECT, [rebase]);

    /* When */
    const lists = new SettingsService(store).savedPrompts(PROJECT);

    /* Then */
    assert.deepEqual(lists, {global: [ask], project: [rebase]});
});

test('without a project only the global list is read', () => {
    /* Given */
    const settings = new SettingsService(new MemoryStore());
    settings.setSavedPrompts(null, [ask]);
    settings.setSavedPrompts(PROJECT, [rebase]);

    /* When */
    const lists = settings.savedPrompts(null);

    /* Then */
    assert.deepEqual(lists, {global: [ask], project: []});
});

test('a write answers the list as stored, without entries it cannot read', () => {
    /* Given */
    const settings = new SettingsService(new MemoryStore());

    /* When */
    const stored = settings.setSavedPrompts(null, [ask, {label: 'no id', text: 'x'}]);

    /* Then */
    assert.deepEqual(stored, [ask]);
    assert.deepEqual(settings.savedPrompts(null).global, [ask]);
});

test('emptying a project’s list takes the key out of its blob', () => {
    /* Given */
    const store = new MemoryStore();
    const settings = new SettingsService(store);
    settings.setSavedPrompts(PROJECT, [rebase]);

    /* When */
    settings.setSavedPrompts(PROJECT, []);

    /* Then */
    assert.deepEqual(store.get('project:' + PROJECT), {});
});

test('saved prompts are not a launch setting', () => {
    /* Given */
    const settings = new SettingsService(new MemoryStore());
    settings.setSavedPrompts(PROJECT, [rebase]);

    /* When */
    const effective = settings.effective(PROJECT);

    /* Then */
    assert.equal(effective.savedPrompts, undefined);
});

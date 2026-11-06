/**
 * Settings → Saved prompts (#344): the rows and ⌘ keys the editor shows, and
 * what adding, editing, moving between scopes, reordering and deleting does
 * to the stored lists and which of them it writes.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    deletePrompt,
    draftFor,
    filterAfter,
    movePrompt,
    newDraft,
    promptListsFrom,
    promptRows,
    savePrompt,
    type PromptLists,
} from '../src/renderer/ui/settings/saved-prompts-editor';
import type {SavedPrompt} from '../src/domain/settings/saved-prompts';

const APP = '/Users/me/code/app';
const SITE = '/Users/me/code/site';

function prompt(id: string, patch: Partial<SavedPrompt> = {}): SavedPrompt {
    return {id, label: 'Prompt ' + id, text: 'Do ' + id, mode: 'send', ...patch};
}

function lists(global: SavedPrompt[], projects: Record<string, SavedPrompt[]> = {}): PromptLists {
    return promptListsFrom(
        global,
        Object.entries(projects).map(([projectPath, prompts]) => ({projectPath, prompts})),
    );
}

function ids(prompts: readonly SavedPrompt[] | undefined): string[] {
    return (prompts ?? []).map((p) => p.id);
}

// ── Rows ──

test('all prompts show global first, then each project’s, with the keys a session in it gets', () => {
    /* Given */
    const stored = lists([prompt('g1'), prompt('g2')], {[APP]: [prompt('a1')], [SITE]: [prompt('s1'), prompt('s2')]});

    /* When */
    const rows = promptRows(stored, 'all');

    /* Then */
    assert.deepEqual(
        rows.map((row) => [row.prompt.id, row.scope, row.key]),
        [
            ['g1', null, 1],
            ['g2', null, 2],
            ['a1', APP, 3],
            ['s1', SITE, 3],
            ['s2', SITE, 4],
        ],
    );
});

test('a project’s prompts past the ninth key get none', () => {
    /* Given */
    const global = Array.from({length: 8}, (_, i) => prompt('g' + i));
    const stored = lists(global, {[APP]: [prompt('a1'), prompt('a2')]});

    /* When */
    const rows = promptRows(stored, APP);

    /* Then */
    assert.deepEqual(
        rows.map((row) => [row.prompt.id, row.key]),
        [
            ['a1', 9],
            ['a2', null],
        ],
    );
});

test('filtered to everywhere, only the global prompts show', () => {
    /* Given */
    const stored = lists([prompt('g1')], {[APP]: [prompt('a1')]});

    /* When */
    const rows = promptRows(stored, null);

    /* Then */
    assert.deepEqual(
        rows.map((row) => row.prompt.id),
        ['g1'],
    );
});

test('projects without prompts are not kept as lists', () => {
    /* Given */
    const read = [
        {projectPath: APP, prompts: [prompt('a1')]},
        {projectPath: SITE, prompts: []},
    ];

    /* When */
    const stored = promptListsFrom([], read);

    /* Then */
    assert.deepEqual(Object.keys(stored.projects), [APP]);
});

// ── Adding and editing ──

test('a new prompt goes last in the list the filter shows, under the new id', () => {
    /* Given */
    const stored = lists([prompt('g1')], {[APP]: [prompt('a1')]});
    const draft = {...newDraft(APP), label: 'Rebuild', text: 'Rebuild and restart', mode: 'input' as const};

    /* When */
    const change = savePrompt(stored, draft, 'new-id')!;

    /* Then */
    assert.deepEqual(ids(change.lists.projects[APP]), ['a1', 'new-id']);
    assert.deepEqual(change.lists.projects[APP]![1], {
        id: 'new-id',
        label: 'Rebuild',
        text: 'Rebuild and restart',
        mode: 'input',
    });
    assert.deepEqual(
        change.writes.map((write) => [write.projectPath, ids(write.prompts)]),
        [[APP, ['a1', 'new-id']]],
    );
});

test('a new prompt from “All” is kept everywhere', () => {
    /* Given */
    const draft = newDraft('all');

    /* When */
    const scope = draft.scope;

    /* Then */
    assert.equal(scope, null);
});

test('a prompt with no label is labelled with its text’s first line', () => {
    /* Given */
    const draft = {...newDraft(null), label: '  ', text: 'Where are we?\nThree lines.'};

    /* When */
    const change = savePrompt(lists([]), draft, 'n')!;

    /* Then */
    assert.equal(change.lists.global[0]!.label, 'Where are we?');
});

test('a prompt with no text is not saved', () => {
    /* Given */
    const draft = {...newDraft(null), label: 'Empty', text: '   '};

    /* When */
    const change = savePrompt(lists([]), draft, 'n');

    /* Then */
    assert.equal(change, null);
});

test('an edited prompt keeps its id and its place', () => {
    /* Given */
    const stored = lists([prompt('g1'), prompt('g2'), prompt('g3')]);
    const draft = {...draftFor(stored, 'g2')!, text: 'Something else', mode: 'input' as const};

    /* When */
    const change = savePrompt(stored, draft, 'unused')!;

    /* Then */
    assert.deepEqual(ids(change.lists.global), ['g1', 'g2', 'g3']);
    assert.equal(change.lists.global[1]!.text, 'Something else');
    assert.equal(change.lists.global[1]!.mode, 'input');
    assert.deepEqual(
        change.writes.map((write) => write.projectPath),
        [null],
    );
});

// ── Scope ──

test('moving a prompt from everywhere to a project takes it out of the global list and into the project’s', () => {
    /* Given */
    const stored = lists([prompt('g1'), prompt('g2')], {[APP]: [prompt('a1')]});
    const draft = {...draftFor(stored, 'g1')!, scope: APP};

    /* When */
    const change = savePrompt(stored, draft, 'unused')!;

    /* Then */
    assert.deepEqual(ids(change.lists.global), ['g2']);
    assert.deepEqual(ids(change.lists.projects[APP]), ['a1', 'g1']);
    assert.deepEqual(
        change.writes.map((write) => [write.projectPath, ids(write.prompts)]),
        [
            [null, ['g2']],
            [APP, ['a1', 'g1']],
        ],
    );
});

test('moving a project’s last prompt everywhere empties its list and drops the project', () => {
    /* Given */
    const stored = lists([prompt('g1')], {[APP]: [prompt('a1')]});
    const draft = {...draftFor(stored, 'a1')!, scope: null};

    /* When */
    const change = savePrompt(stored, draft, 'unused')!;

    /* Then */
    assert.deepEqual(ids(change.lists.global), ['g1', 'a1']);
    assert.equal(change.lists.projects[APP], undefined);
    assert.deepEqual(
        change.writes.map((write) => [write.projectPath, ids(write.prompts)]),
        [
            [APP, []],
            [null, ['g1', 'a1']],
        ],
    );
});

test('a filter on a project left without prompts shows all again', () => {
    /* Given */
    const after = lists([prompt('g1')]);

    /* When */
    const filter = filterAfter(after, APP);

    /* Then */
    assert.equal(filter, 'all');
});

// ── Reordering ──

test('moving a prompt down swaps it with the next one, and its key with it', () => {
    /* Given */
    const stored = lists([prompt('g1'), prompt('g2'), prompt('g3')]);

    /* When */
    const change = movePrompt(stored, 'g1', 1)!;

    /* Then */
    assert.deepEqual(ids(change.lists.global), ['g2', 'g1', 'g3']);
    assert.deepEqual(
        promptRows(change.lists, 'all').map((row) => [row.prompt.id, row.key]),
        [
            ['g2', 1],
            ['g1', 2],
            ['g3', 3],
        ],
    );
    assert.deepEqual(
        change.writes.map((write) => write.projectPath),
        [null],
    );
});

test('a project’s prompt moves within its own list only', () => {
    /* Given */
    const stored = lists([prompt('g1')], {[APP]: [prompt('a1'), prompt('a2')]});

    /* When */
    const change = movePrompt(stored, 'a2', -1)!;

    /* Then */
    assert.deepEqual(ids(change.lists.global), ['g1']);
    assert.deepEqual(ids(change.lists.projects[APP]), ['a2', 'a1']);
    assert.deepEqual(
        change.writes.map((write) => write.projectPath),
        [APP],
    );
});

test('the first prompt cannot move up, nor the last down', () => {
    /* Given */
    const stored = lists([prompt('g1'), prompt('g2')]);

    /* When */
    const up = movePrompt(stored, 'g1', -1);
    const down = movePrompt(stored, 'g2', 1);

    /* Then */
    assert.equal(up, null);
    assert.equal(down, null);
});

// ── Deleting ──

test('deleting a prompt writes its list without it', () => {
    /* Given */
    const stored = lists([prompt('g1')], {[APP]: [prompt('a1'), prompt('a2')]});

    /* When */
    const change = deletePrompt(stored, 'a1')!;

    /* Then */
    assert.deepEqual(ids(change.lists.projects[APP]), ['a2']);
    assert.deepEqual(
        change.writes.map((write) => [write.projectPath, ids(write.prompts)]),
        [[APP, ['a2']]],
    );
});

test('deleting a prompt that is gone changes nothing', () => {
    /* Given */
    const stored = lists([prompt('g1')]);

    /* When */
    const change = deletePrompt(stored, 'nope');

    /* Then */
    assert.equal(change, null);
});

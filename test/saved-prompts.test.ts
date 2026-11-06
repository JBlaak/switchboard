/**
 * Saved prompts (#339): reading a stored list, the order and ⌘ keys the tray
 * offers, filling in a session's facts, and what typing one writes.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    fillSavedPrompt,
    parseSavedPrompts,
    resolveSavedPrompts,
    savedPromptForKey,
    savedPromptInput,
    type SavedPrompt,
} from '../src/domain/settings/saved-prompts';
import {PASTE_END, PASTE_START} from '../src/domain/terminal/paste';

function prompt(id: string, patch: Partial<SavedPrompt> = {}): SavedPrompt {
    return {id, label: 'Prompt ' + id, text: 'Do ' + id, mode: 'send', ...patch};
}

// ── Reading ──

test('a stored list keeps its prompts in order', () => {
    /* Given */
    const stored = [
        {id: 'a', label: 'Where are we?', text: 'Where are we?', mode: 'send'},
        {id: 'b', label: 'Rebase', text: 'Rebase on main', mode: 'input'},
    ];

    /* When */
    const prompts = parseSavedPrompts(stored);

    /* Then */
    assert.deepEqual(prompts, stored);
});

test('entries without an id or text are skipped, and anything but a list reads as none', () => {
    /* Given */
    const stored = [null, 'x', {label: 'No id', text: 'x'}, {id: 'a', label: 'No text'}, prompt('ok')];

    /* When */
    const prompts = parseSavedPrompts(stored);

    /* Then */
    assert.deepEqual(
        prompts.map((p) => p.id),
        ['ok'],
    );
    assert.deepEqual(parseSavedPrompts({id: 'a'}), []);
    assert.deepEqual(parseSavedPrompts(undefined), []);
});

test('an unknown mode is send, and a blank label falls back to the text’s first line', () => {
    /* Given */
    const stored = [{id: 'a', label: '  ', text: '\nCommit and open a PR\nthen wait for CI', mode: 'later'}];

    /* When */
    const [read] = parseSavedPrompts(stored);

    /* Then */
    assert.equal(read!.mode, 'send');
    assert.equal(read!.label, 'Commit and open a PR');
});

// ── Order and keys ──

test('global prompts come first, then the project’s, keyed 1 onwards', () => {
    /* Given */
    const global = [prompt('g1'), prompt('g2')];
    const project = [prompt('p1')];

    /* When */
    const resolved = resolveSavedPrompts(global, project);

    /* Then */
    assert.deepEqual(
        resolved.map((p) => [p.id, p.scope, p.key]),
        [
            ['g1', 'global', 1],
            ['g2', 'global', 2],
            ['p1', 'project', 3],
        ],
    );
});

test('only the first nine get a key', () => {
    /* Given */
    const global = Array.from({length: 6}, (_, i) => prompt('g' + i));
    const project = Array.from({length: 5}, (_, i) => prompt('p' + i));

    /* When */
    const resolved = resolveSavedPrompts(global, project);

    /* Then */
    assert.deepEqual(
        resolved.map((p) => p.key),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, null, null],
    );
    assert.equal(resolved[8]!.id, 'p2');
});

test('a key finds the prompt it sends, and an unused key none', () => {
    /* Given */
    const resolved = resolveSavedPrompts([prompt('g1')], [prompt('p1')]);

    /* When */
    const second = savedPromptForKey(resolved, 2);

    /* Then */
    assert.equal(second?.id, 'p1');
    assert.equal(savedPromptForKey(resolved, 3), null);
});

// ── Placeholders ──

test('placeholders fill from the session’s facts', () => {
    /* Given */
    const text = 'Rebase {branch} of {project} on main, for {task} ({pr})';

    /* When */
    const filled = fillSavedPrompt(text, {
        branch: 'tray/saved-prompts',
        project: 'switchboard',
        task: 'Saved prompts',
        pr: '#345',
    });

    /* Then */
    assert.equal(filled, 'Rebase tray/saved-prompts of switchboard on main, for Saved prompts (#345)');
});

test('placeholder names are case-insensitive and values are trimmed', () => {
    /* When */
    const filled = fillSavedPrompt('On {Branch}.', {branch: '  main '});

    /* Then */
    assert.equal(filled, 'On main.');
});

test('a missing placeholder in the middle leaves one space', () => {
    /* When */
    const filled = fillSavedPrompt('Rebase {branch} on main', {branch: null});

    /* Then */
    assert.equal(filled, 'Rebase on main');
});

test('a missing placeholder before punctuation or at the end leaves no space', () => {
    /* When */
    const filled = fillSavedPrompt('Check {pr}, then merge {branch}', {});

    /* Then */
    assert.equal(filled, 'Check, then merge');
});

test('a blank value is missing, and so is an unknown placeholder', () => {
    /* When */
    const filled = fillSavedPrompt('{task} Ship {colour} it {pr}.', {task: '   ', pr: ''});

    /* Then */
    assert.equal(filled, 'Ship it.');
});

test('neighbouring missing placeholders go together, without a double space', () => {
    /* When */
    const filled = fillSavedPrompt('Look at {task} {pr} now', {});

    /* Then */
    assert.equal(filled, 'Look at now');
});

test('a line of nothing but missing placeholders goes, and the other lines keep their layout', () => {
    /* Given */
    const text = 'Context:\n  {task} {pr}\n  - keep  two spaces\nDone';

    /* When */
    const filled = fillSavedPrompt(text, {});

    /* Then */
    assert.equal(filled, 'Context:\n  - keep  two spaces\nDone');
});

test('braces that are not a placeholder are kept as written', () => {
    /* When */
    const filled = fillSavedPrompt('Send {"a": 1} and { spaced }', {});

    /* Then */
    assert.equal(filled, 'Send {"a": 1} and { spaced }');
});

// ── What gets typed ──

test('a send prompt is pasted filled, and Enter follows it', () => {
    /* When */
    const input = savedPromptInput(prompt('a', {text: 'Push {branch}', mode: 'send'}), {branch: 'main'});

    /* Then */
    assert.deepEqual(input, {paste: PASTE_START + 'Push main' + PASTE_END, submit: true});
});

test('an input prompt is pasted without Enter', () => {
    /* When */
    const input = savedPromptInput(prompt('a', {text: 'Explain ', mode: 'input'}), {});

    /* Then */
    assert.deepEqual(input, {paste: PASTE_START + 'Explain' + PASTE_END, submit: false});
});

test('a prompt that fills to nothing types nothing', () => {
    /* When */
    const input = savedPromptInput(prompt('a', {text: '{pr}'}), {});

    /* Then */
    assert.equal(input, null);
});

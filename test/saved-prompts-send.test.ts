/**
 * Sending a saved prompt from the renderer (#339): what reaches the session's
 * pty, and when Enter follows it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sendSavedPromptWith, type SendSavedPromptSteps} from '../src/renderer/ui/session-tray/saved-prompts';
import {PASTE_END, PASTE_START, SUBMIT_DELAY_MS} from '../src/domain/terminal/paste';
import type {SavedPrompt} from '../src/domain/settings/saved-prompts';

function steps(hasTerminal = true) {
    const writes: Array<[string, string]> = [];
    const pending: Array<{fn: () => void; ms: number}> = [];
    const state = {hasTerminal};
    const fake: SendSavedPromptSteps = {
        write: (sessionId, data) => void writes.push([sessionId, data]),
        later: (fn, ms) => void pending.push({fn, ms}),
        hasTerminal: () => state.hasTerminal,
    };
    const runLater = () => pending.splice(0).forEach(({fn}) => fn());
    return {fake, writes, pending, state, runLater};
}

const send: SavedPrompt = {id: 'a', label: 'Push', text: 'Push {branch} and open a PR', mode: 'send'};
const input: SavedPrompt = {id: 'b', label: 'Explain', text: 'Explain {task}: ', mode: 'input'};

test('a send prompt is typed filled, then Enter after the paste has landed', () => {
    /* Given */
    const {fake, writes, pending, runLater} = steps();

    /* When */
    const sent = sendSavedPromptWith(fake, 's1', send, {branch: 'main'});
    runLater();

    /* Then */
    assert.equal(sent, true);
    assert.deepEqual(writes, [
        ['s1', PASTE_START + 'Push main and open a PR' + PASTE_END],
        ['s1', '\r'],
    ]);
    assert.equal(pending.length, 0);
});

test('Enter waits the submit delay', () => {
    /* Given */
    const {fake, pending} = steps();

    /* When */
    sendSavedPromptWith(fake, 's1', send, {});

    /* Then */
    assert.deepEqual(
        pending.map((p) => p.ms),
        [SUBMIT_DELAY_MS],
    );
});

test('an input prompt is typed without Enter', () => {
    /* Given */
    const {fake, writes, pending} = steps();

    /* When */
    const sent = sendSavedPromptWith(fake, 's1', input, {task: 'Saved prompts'});

    /* Then */
    assert.equal(sent, true);
    assert.deepEqual(writes, [['s1', PASTE_START + 'Explain Saved prompts:' + PASTE_END]]);
    assert.equal(pending.length, 0);
});

test('nothing is typed while a phone has the session’s terminal', () => {
    /* Given */
    const {fake, writes} = steps(false);

    /* When */
    const sent = sendSavedPromptWith(fake, 's1', send, {});

    /* Then */
    assert.equal(sent, false);
    assert.deepEqual(writes, []);
});

test('Enter is not pressed if a phone took the terminal in between', () => {
    /* Given */
    const {fake, writes, state, runLater} = steps();
    sendSavedPromptWith(fake, 's1', send, {});

    /* When */
    state.hasTerminal = false;
    runLater();

    /* Then */
    assert.equal(writes.length, 1);
});

test('a prompt that fills to nothing types nothing', () => {
    /* Given */
    const {fake, writes} = steps();

    /* When */
    const sent = sendSavedPromptWith(fake, 's1', {...send, text: '{pr}'}, {});

    /* Then */
    assert.equal(sent, false);
    assert.deepEqual(writes, []);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {LOOPS_PAUSED_CLASS, installLoopPause} from '../src/renderer/lib/motion/loops';
import type {LoopDocument, LoopWindow} from '../src/renderer/lib/motion/loops';

type Listener = () => void;

function fakeWindow(): LoopWindow & {fire(type: 'focus' | 'blur'): void; count(): number} {
    const listeners = new Map<string, Set<Listener>>();
    return {
        addEventListener: (type, listener) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type)!.add(listener);
        },
        removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
        fire: (type) => listeners.get(type)?.forEach((listener) => listener()),
        count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    };
}

function fakeDocument(state: {hidden: boolean; focused: boolean}): LoopDocument & {
    classes: Set<string>;
    fire(): void;
    count(): number;
} {
    const classes = new Set<string>();
    const listeners = new Set<Listener>();
    return {
        classes,
        get hidden() {
            return state.hidden;
        },
        hasFocus: () => state.focused,
        documentElement: {
            classList: {
                toggle: (token, force) => {
                    if (force) classes.add(token);
                    else classes.delete(token);
                    return force;
                },
            },
        },
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        fire: () => listeners.forEach((listener) => listener()),
        count: () => listeners.size,
    };
}

test('loops run while the window is shown and focused', () => {
    /* Given */
    const state = {hidden: false, focused: true};
    const doc = fakeDocument(state);

    /* When */
    installLoopPause(fakeWindow(), doc);

    /* Then */
    assert.equal(doc.classes.has(LOOPS_PAUSED_CLASS), false);
});

test('loops pause when the window loses focus and run again when it comes back', () => {
    /* Given */
    const state = {hidden: false, focused: true};
    const win = fakeWindow();
    const doc = fakeDocument(state);
    installLoopPause(win, doc);

    /* When */
    state.focused = false;
    win.fire('blur');
    const pausedWhileAway = doc.classes.has(LOOPS_PAUSED_CLASS);
    state.focused = true;
    win.fire('focus');

    /* Then */
    assert.equal(pausedWhileAway, true);
    assert.equal(doc.classes.has(LOOPS_PAUSED_CLASS), false);
});

test('loops pause while the window is hidden, focused or not', () => {
    /* Given */
    const state = {hidden: false, focused: true};
    const doc = fakeDocument(state);
    installLoopPause(fakeWindow(), doc);

    /* When */
    state.hidden = true;
    doc.fire();

    /* Then */
    assert.equal(doc.classes.has(LOOPS_PAUSED_CLASS), true);
});

test('a window that starts out of focus starts with its loops paused', () => {
    /* Given */
    const doc = fakeDocument({hidden: false, focused: false});

    /* When */
    installLoopPause(fakeWindow(), doc);

    /* Then */
    assert.equal(doc.classes.has(LOOPS_PAUSED_CLASS), true);
});

test('the teardown stops following focus and visibility', () => {
    /* Given */
    const win = fakeWindow();
    const doc = fakeDocument({hidden: false, focused: true});
    const stop = installLoopPause(win, doc);

    /* When */
    stop();

    /* Then */
    assert.equal(win.count(), 0);
    assert.equal(doc.count(), 0);
});

test('every looping animation in the main window follows --loop-state', () => {
    /* Given */
    const dir = join(__dirname, '../src/renderer/styles');
    const missing: string[] = [];

    /* When */
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.scss'))) {
        const lines = readFileSync(join(dir, file), 'utf8').split('\n');
        lines.forEach((line, index) => {
            if (!/^\s*animation:[^;]*\binfinite\b/.test(line)) return;
            const rest = lines.slice(index + 1);
            const end = rest.findIndex((next) => next.includes('}'));
            const block = rest.slice(0, end === -1 ? undefined : end).join('\n');
            const important = line.includes('!important');
            const follows = important
                ? /animation-play-state: var\(--loop-state, running\) !important;/.test(block)
                : /animation-play-state: var\(--loop-state, running\);/.test(block);
            if (!follows) missing.push(`${file}:${index + 1}`);
        });
    }

    /* Then */
    assert.deepEqual(missing, [], 'add `animation-play-state: var(--loop-state, running);` after these');
});

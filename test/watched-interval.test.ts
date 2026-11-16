import {test, mock} from 'node:test';
import assert from 'node:assert/strict';
import {isWatched, setWatchedInterval} from '../src/renderer/lib/watched-interval';
import type {WatchedDocument} from '../src/renderer/lib/watched-interval';
import type {LoopWindow} from '../src/renderer/lib/motion/loops';

type Listener = () => void;
type State = {hidden: boolean; focused: boolean};

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

function fakeDocument(state: State): WatchedDocument & {fire(): void; count(): number} {
    const listeners = new Set<Listener>();
    return {
        get hidden() {
            return state.hidden;
        },
        hasFocus: () => state.focused,
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        fire: () => listeners.forEach((listener) => listener()),
        count: () => listeners.size,
    };
}

/** A watched interval of 1 s on fake timers, with its window, document and tick count. */
function setUp(state: State) {
    mock.timers.enable({apis: ['setInterval']});
    const win = fakeWindow();
    const doc = fakeDocument(state);
    let ticks = 0;
    const stop = setWatchedInterval(() => ticks++, 1_000, win, doc);
    return {win, doc, stop, ticks: () => ticks};
}

test('the window is watched only while shown and in focus', () => {
    /* Given */
    const cases: Array<[State, boolean]> = [
        [{hidden: false, focused: true}, true],
        [{hidden: false, focused: false}, false],
        [{hidden: true, focused: true}, false],
        [{hidden: true, focused: false}, false],
    ];

    /* When */
    const answers = cases.map(([state]) => isWatched({hidden: state.hidden, hasFocus: () => state.focused}));

    /* Then */
    assert.deepEqual(
        answers,
        cases.map(([, watched]) => watched),
    );
});

test('a watched window ticks on every interval', (t) => {
    /* Given */
    const poll = setUp({hidden: false, focused: true});
    t.after(() => (poll.stop(), mock.timers.reset()));

    /* When */
    mock.timers.tick(3_000);

    /* Then */
    assert.equal(poll.ticks(), 3);
});

test('ticks are skipped while the window is out of focus', (t) => {
    /* Given */
    const poll = setUp({hidden: false, focused: false});
    t.after(() => (poll.stop(), mock.timers.reset()));

    /* When */
    mock.timers.tick(3_000);

    /* Then */
    assert.equal(poll.ticks(), 0);
});

test('ticks are skipped while the window is hidden', (t) => {
    /* Given */
    const poll = setUp({hidden: true, focused: true});
    t.after(() => (poll.stop(), mock.timers.reset()));

    /* When */
    mock.timers.tick(3_000);

    /* Then */
    assert.equal(poll.ticks(), 0);
});

test('coming back after a skipped tick runs once at once', (t) => {
    /* Given */
    const state = {hidden: false, focused: false};
    const poll = setUp(state);
    t.after(() => (poll.stop(), mock.timers.reset()));
    mock.timers.tick(2_500);

    /* When */
    state.focused = true;
    poll.win.fire('focus');

    /* Then */
    assert.equal(poll.ticks(), 1);
});

test('showing a hidden window after a skipped tick runs once at once', (t) => {
    /* Given */
    const state = {hidden: true, focused: true};
    const poll = setUp(state);
    t.after(() => (poll.stop(), mock.timers.reset()));
    mock.timers.tick(1_000);

    /* When */
    state.hidden = false;
    poll.doc.fire();

    /* Then */
    assert.equal(poll.ticks(), 1);
});

test('coming back before any tick was skipped does not run', (t) => {
    /* Given */
    const state = {hidden: false, focused: false};
    const poll = setUp(state);
    t.after(() => (poll.stop(), mock.timers.reset()));
    mock.timers.tick(500);

    /* When */
    state.focused = true;
    poll.win.fire('focus');

    /* Then */
    assert.equal(poll.ticks(), 0);
});

test('flipping focus back and forth catches up only once', (t) => {
    /* Given */
    const state = {hidden: false, focused: false};
    const poll = setUp(state);
    t.after(() => (poll.stop(), mock.timers.reset()));
    mock.timers.tick(1_000);

    /* When */
    for (let i = 0; i < 5; i++) {
        state.focused = true;
        poll.win.fire('focus');
        poll.doc.fire();
        state.focused = false;
        poll.win.fire('blur');
    }

    /* Then */
    assert.equal(poll.ticks(), 1);
});

test('a visibility change while still out of focus waits for the focus', (t) => {
    /* Given */
    const state = {hidden: true, focused: false};
    const poll = setUp(state);
    t.after(() => (poll.stop(), mock.timers.reset()));
    mock.timers.tick(1_000);

    /* When */
    state.hidden = false;
    poll.doc.fire();
    const whileUnfocused = poll.ticks();
    state.focused = true;
    poll.win.fire('focus');

    /* Then */
    assert.equal(whileUnfocused, 0);
    assert.equal(poll.ticks(), 1);
});

test('the stop clears the timer and removes its listeners', (t) => {
    /* Given */
    const state = {hidden: false, focused: true};
    const poll = setUp(state);
    t.after(() => mock.timers.reset());

    /* When */
    poll.stop();
    mock.timers.tick(3_000);

    /* Then */
    assert.equal(poll.ticks(), 0);
    assert.equal(poll.win.count(), 0);
    assert.equal(poll.doc.count(), 0);
});

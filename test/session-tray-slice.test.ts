import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    TRAY_GRACE_MS,
    TRAY_INTENT_MS,
    TRAY_SENT_MS,
    initialSessionTrayState,
    rekeySessionTray,
    sessionStatsIn,
    sessionTrayReducer,
    trayIsOpen,
} from '../src/renderer/state/session-tray-slice';
import type {SessionTrayState} from '../src/renderer/state/session-tray-slice';
import type {RendererEvent} from '../src/renderer/state/events';
import type {SessionStats} from '../src/domain/session/stats';

const T0 = 1_000_000;

function run(state: SessionTrayState, ...events: RendererEvent[]): SessionTrayState {
    return events.reduce(sessionTrayReducer, state);
}

/** The timer the state asks for, run out. */
function fire(state: SessionTrayState): RendererEvent {
    assert.notEqual(state.deadline, null, 'a timer to run out');
    return {type: 'trayTimerFired', deadline: state.deadline!};
}

const enter = (at: number): RendererEvent => ({type: 'trayPointerEntered', at});
const leave = (at: number): RendererEvent => ({type: 'trayPointerLeft', at});

function opened(): SessionTrayState {
    const intent = run(initialSessionTrayState, enter(T0));
    return run(intent, fire(intent));
}

test('resting on the bar is intent first, and opens the tray 120 ms later', () => {
    /* Given */
    const closed = initialSessionTrayState;

    /* When */
    const intent = run(closed, enter(T0));
    const open = run(intent, fire(intent));

    /* Then */
    assert.equal(intent.phase, 'intent');
    assert.equal(intent.deadline, T0 + TRAY_INTENT_MS);
    assert.equal(trayIsOpen(intent.phase), false);
    assert.equal(open.phase, 'open');
    assert.equal(open.deadline, null);
    assert.equal(trayIsOpen(open.phase), true);
});

test('crossing the bar in under 120 ms never opens it', () => {
    /* Given */
    const intent = run(initialSessionTrayState, enter(T0));
    const stale = fire(intent);

    /* When */
    const after = run(intent, leave(T0 + 60), stale);

    /* Then */
    assert.equal(after.phase, 'closed');
    assert.equal(after.deadline, null);
});

test('leaving starts a 250 ms grace, then the tray closes', () => {
    /* Given */
    const open = opened();

    /* When */
    const grace = run(open, leave(T0 + 500));
    const closed = run(grace, fire(grace));

    /* Then */
    assert.equal(grace.phase, 'grace');
    assert.equal(grace.deadline, T0 + 500 + TRAY_GRACE_MS);
    assert.equal(trayIsOpen(grace.phase), true);
    assert.equal(closed.phase, 'closed');
});

test('coming back within the grace keeps it open, and the grace timer then does nothing', () => {
    /* Given */
    const grace = run(opened(), leave(T0 + 500));
    const graceTimer = fire(grace);

    /* When */
    const back = run(grace, enter(T0 + 600));
    const after = run(back, graceTimer);

    /* Then */
    assert.equal(back.phase, 'open');
    assert.equal(back.deadline, null);
    assert.equal(after, back);
});

test('sending a prompt flashes it for 450 ms, then closes without a grace, whatever the pointer does', () => {
    /* Given */
    const open = opened();

    /* When */
    const sent = run(open, {type: 'trayPromptSent', promptId: 'p1', at: T0 + 700});
    const wandered = run(sent, leave(T0 + 750), enter(T0 + 800));
    const closed = run(wandered, fire(wandered));

    /* Then */
    assert.equal(sent.phase, 'sent');
    assert.equal(sent.sent, 'p1');
    assert.equal(sent.deadline, T0 + 700 + TRAY_SENT_MS);
    assert.equal(wandered, sent);
    assert.equal(closed.phase, 'closed');
    // Kept while the tray clips up, so its row does not change label on the way out.
    assert.equal(closed.sent, 'p1');
});

test('⌘1 with the tray closed opens it at once on the sent row', () => {
    /* Given */
    const closed = initialSessionTrayState;

    /* When */
    const sent = run(closed, {type: 'trayPromptSent', promptId: 'p2', at: T0});

    /* Then */
    assert.equal(sent.phase, 'sent');
    assert.equal(trayIsOpen(sent.phase), true);
});

test('the next hover forgets the last send', () => {
    /* Given */
    const sent = run(initialSessionTrayState, {type: 'trayPromptSent', promptId: 'p1', at: T0});
    const closed = run(sent, fire(sent));

    /* When */
    const intent = run(closed, enter(T0 + 2000));

    /* Then */
    assert.equal(intent.sent, null);
});

test('the keyboard opens it at once and Esc closes it', () => {
    /* Given */
    const closed = initialSessionTrayState;

    /* When */
    const open = run(closed, {type: 'trayOpened'});
    const shut = run(open, {type: 'trayClosed'});

    /* Then */
    assert.equal(open.phase, 'open');
    assert.equal(open.deadline, null);
    assert.equal(shut.phase, 'closed');
});

test('another session on screen closes the tray', () => {
    /* Given */
    const open = opened();

    /* When */
    const after = run(open, {type: 'sessionShown', sessionId: 's2', name: 'Other'});

    /* Then */
    assert.equal(after.phase, 'closed');
});

test('stats are kept for the session they are for, and follow a re-key', () => {
    /* Given */
    const stats: SessionStats = {
        contextUsed: 0.62,
        messageCount: 125,
        startedAt: '2026-11-06T10:00:00.000Z',
        branch: 'feat/session-tray',
        shell: null,
    };

    /* When */
    const loaded = run(initialSessionTrayState, {type: 'sessionStatsLoaded', sessionId: 's1', stats});
    const rekeyed = rekeySessionTray(loaded, 's1', 's9');

    /* Then */
    assert.equal(sessionStatsIn(loaded, 's1')?.branch, 'feat/session-tray');
    assert.equal(sessionStatsIn(loaded, 's2'), null);
    assert.equal(sessionStatsIn(rekeyed, 's9'), stats);
    assert.equal(sessionStatsIn(rekeyed, 's1'), null);
});

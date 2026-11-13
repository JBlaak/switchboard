/**
 * The inbox's state machine (#413): arriving, the wake rules, leaving, what
 * you do to an item, timed snoozes, Done's seven days and the counts.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
    DONE_KEPT_MS,
    expired,
    finish,
    inboxSummary,
    managerCounts,
    markRead,
    markRegressed,
    returnToInbox,
    setNotes,
    setStage,
    snooze,
    startWork,
    syncSource,
    toBacklog,
    unwatched,
    wakeDue,
    type SyncContext,
} from '../src/domain/inbox/items';
import type {InboxFacts, InboxItem, InboxState} from '../src/domain/inbox/model';
import {DAY, HOUR, ME, NOW, THRESHOLDS, bug, issue} from './support/inbox-fixtures';

const CONTEXT: SyncContext = {
    now: NOW,
    complete: true,
    watchingSince: NOW - 30 * DAY,
    thresholds: THRESHOLDS,
    viewer: ME,
};

/** The items a first sync makes of these facts. */
function arrive(...facts: InboxFacts[]): InboxItem[] {
    return syncSource([], facts, {...CONTEXT, watchingSince: NOW}).items;
}

/** One item, put in a state. */
function inState(facts: InboxFacts, state: InboxState): InboxItem {
    return {...arrive(facts)[0]!, state};
}

/** Sync one item against its next facts; its state after. */
function stateAfter(item: InboxItem, next: InboxFacts, context: Partial<SyncContext> = {}): InboxState['kind'] {
    const {items} = syncSource([item], [next], {...CONTEXT, now: NOW + HOUR, ...context});
    return items[0]!.state.kind;
}

const PUT_AWAY: InboxState[] = [{kind: 'read'}, {kind: 'snoozed', until: null}, {kind: 'backlog'}];

// ── Arriving ──

test("a source's first sync lists all its open items as unread", () => {
    /* When */
    const {items, removed} = syncSource([], [bug('a'), bug('b'), bug('c')], CONTEXT);

    /* Then */
    assert.deepEqual(
        items.map((item) => [item.key, item.state.kind]),
        [
            ['bug:connect-api:a', 'unread'],
            ['bug:connect-api:b', 'unread'],
            ['bug:connect-api:c', 'unread'],
        ],
    );
    assert.deepEqual(removed, []);
});

test('an item arriving later is unread too, and remembers when it arrived', () => {
    /* Given */
    const known = arrive(issue(1));

    /* When */
    const {items} = syncSource(known, [issue(1), issue(2)], {...CONTEXT, now: NOW + DAY});

    /* Then */
    const second = items.find((item) => item.key === 'issue:movelab/connect#2')!;
    assert.equal(second.state.kind, 'unread');
    assert.equal(second.createdAt, NOW + DAY);
    assert.equal(second.notes, '');
});

test('an issue has no signals; a bug has them from its facts', () => {
    /* When */
    const [anIssue, aBug] = arrive(issue(1), bug('spike', {events24h: 40, events7d: 50}));

    /* Then */
    assert.equal(anIssue!.signals, null);
    assert.deepEqual(aBug!.signals, {new: false, trending: true, regressed: false});
});

// ── Waking ──

for (const state of PUT_AWAY) {
    const name = state.kind === 'snoozed' ? 'snoozed until it changes' : state.kind;
    test(`a ${name} issue turns unread on a new comment`, () => {
        /* Given */
        const item = inState(issue(1, {comments: 1}), state);

        /* When */
        const after = stateAfter(item, issue(1, {comments: 2, lastCommentBy: 'colleague'}));

        /* Then */
        assert.equal(after, 'unread');
    });

    test(`a ${name} issue turns unread on a referencing commit`, () => {
        /* Given */
        const item = inState(issue(1, {references: 0}), state);

        /* When */
        const after = stateAfter(item, issue(1, {references: 1}));

        /* Then */
        assert.equal(after, 'unread');
    });

    test(`a ${name} bug turns unread when it starts trending`, () => {
        /* Given */
        const item = inState(bug('e', {events24h: 2, events7d: 14}), state);

        /* When */
        const after = stateAfter(item, bug('e', {events24h: 40, events7d: 52}));

        /* Then */
        assert.equal(after, 'unread');
    });
}

test('your own comment wakes nothing', () => {
    /* Given */
    const item = inState(issue(1, {comments: 1}), {kind: 'read'});

    /* When */
    const after = stateAfter(item, issue(1, {comments: 2, lastCommentBy: ME}));

    /* Then */
    assert.equal(after, 'read');
});

test('more events alone never wake a bug', () => {
    /* Given */
    const item = inState(bug('e', {events: 100, users: 3}), {kind: 'read'});

    /* When */
    const after = stateAfter(item, bug('e', {events: 900, users: 40, lastSeen: new Date(NOW).toISOString()}));

    /* Then */
    assert.equal(after, 'read');
});

test('a bug that keeps trending wakes once, not on every poll', () => {
    /* Given: it woke for trending, and was read again */
    const trending = bug('e', {events24h: 40, events7d: 52});
    const item = inState(trending, {kind: 'read'});

    /* When */
    const after = stateAfter(item, bug('e', {events24h: 60, events7d: 72}));

    /* Then */
    assert.equal(after, 'read');
});

test('a bug that stops and starts trending again wakes again', () => {
    /* Given */
    const calm = inState(bug('e', {events24h: 40, events7d: 52}), {kind: 'read'});
    const {items} = syncSource([calm], [bug('e', {events24h: 1, events7d: 52})], CONTEXT);

    /* When */
    const after = stateAfter(items[0]!, bug('e', {events24h: 45, events7d: 60}));

    /* Then */
    assert.equal(items[0]!.state.kind, 'read');
    assert.equal(after, 'unread');
});

test('an edited title or a new label only updates what the row shows', () => {
    /* Given */
    const item = inState(issue(1), {kind: 'backlog'});

    /* When */
    const {items} = syncSource([item], [issue(1, {title: 'Renamed', labels: [{name: 'bug', color: 'ee0000'}]})], {
        ...CONTEXT,
    });

    /* Then */
    assert.equal(items[0]!.state.kind, 'backlog');
    assert.equal((items[0]!.facts as {title: string}).title, 'Renamed');
});

test('a timed snooze does not wake on a change, only at its time', () => {
    /* Given */
    const item = inState(issue(1, {comments: 1}), {kind: 'snoozed', until: NOW + DAY});

    /* When */
    const after = stateAfter(item, issue(1, {comments: 5}));

    /* Then */
    assert.equal(after, 'snoozed');
});

test('in progress and done items are not woken by a change', () => {
    /* Given */
    const working = inState(issue(1), {kind: 'inProgress', stage: 'working'});
    const done = inState(issue(2), {kind: 'done', at: NOW});

    /* When */
    const states = [stateAfter(working, issue(1, {comments: 9})), stateAfter(done, issue(2, {comments: 9}))];

    /* Then */
    assert.deepEqual(states, ['inProgress', 'done']);
});

// ── Leaving ──

test('an item the source no longer answers leaves the inbox', () => {
    /* Given: a closed issue, or a bug fixed or ignored in Bugsnag, is no longer in the open list */
    const known = [...arrive(issue(1), issue(2)), inState(issue(3), {kind: 'backlog'})];

    /* When */
    const {items, removed} = syncSource(known, [issue(1)], CONTEXT);

    /* Then */
    assert.deepEqual(
        items.map((item) => item.key),
        ['issue:movelab/connect#1'],
    );
    assert.deepEqual(removed, ['issue:movelab/connect#2', 'issue:movelab/connect#3']);
});

test('a capped answer drops nothing it left out', () => {
    /* Given */
    const known = arrive(issue(1), issue(2));

    /* When */
    const {items, removed} = syncSource(known, [issue(1)], {...CONTEXT, complete: false});

    /* Then */
    assert.equal(items.length, 2);
    assert.deepEqual(removed, []);
});

test("an issue answered as no longer the inbox's leaves even from a capped answer", () => {
    /* Given: issue 2 was assigned to someone else */
    const known = arrive(issue(1), issue(2));

    /* When */
    const {removed} = syncSource(known, [issue(1)], {
        ...CONTEXT,
        complete: false,
        excluded: new Set(['issue:movelab/connect#2']),
    });

    /* Then */
    assert.deepEqual(removed, ['issue:movelab/connect#2']);
});

test('an in-progress or done item stays when the source no longer answers it', () => {
    /* Given: the PR closed the issue, and the page is to move it to Done */
    const known = [
        inState(issue(1), {kind: 'inProgress', stage: 'merged'}),
        inState(issue(2), {kind: 'done', at: NOW}),
    ];

    /* When */
    const {items, removed} = syncSource(known, [], CONTEXT);

    /* Then */
    assert.equal(items.length, 2);
    assert.deepEqual(removed, []);
});

test('the items of a source no longer watched leave, except those being worked on or done', () => {
    /* Given */
    const items = [...arrive(bug('a')), inState(bug('b'), {kind: 'inProgress', stage: 'prCi'}), ...arrive(issue(1))];

    /* When */
    const gone = unwatched(items, 'bug', new Set());

    /* Then */
    assert.deepEqual(gone, ['bug:connect-api:a']);
});

test('done items are dropped seven days after they were done', () => {
    /* Given */
    const items = [
        inState(bug('old'), {kind: 'done', at: NOW - DONE_KEPT_MS}),
        inState(bug('recent'), {kind: 'done', at: NOW - DONE_KEPT_MS + HOUR}),
    ];

    /* When */
    const gone = expired(items, NOW);

    /* Then */
    assert.deepEqual(gone, ['bug:connect-api:old']);
});

// ── What you do ──

test('seeing an unread item reads it; seeing any other leaves it', () => {
    /* Given */
    const unread = arrive(issue(1))[0]!;
    const backlog = inState(issue(2), {kind: 'backlog'});

    /* When */
    const read = markRead(unread);

    /* Then */
    assert.equal(read.state.kind, 'read');
    assert.equal(markRead(backlog), backlog);
});

test('snooze and backlog take an item out of the unread count', () => {
    /* Given */
    const [a, b, c] = arrive(issue(1), issue(2), issue(3));

    /* When */
    const items = [snooze(a!, NOW + DAY), toBacklog(b!), c!];

    /* Then */
    assert.deepEqual(managerCounts(items, 'issue'), {unread: 1, urgent: 0});
});

test('an item being worked on can be neither snoozed nor put in the backlog', () => {
    /* Given */
    const working = startWork(arrive(issue(1))[0]!);

    /* When */
    const snoozed = snooze(working, null);
    const backlogged = toBacklog(working);

    /* Then */
    assert.equal(snoozed, working);
    assert.equal(backlogged, working);
});

test('in-progress items never count, whatever their stage', () => {
    /* Given */
    const items = arrive(bug('a', {events24h: 40, events7d: 50}), bug('b')).map((item) => startWork(item));

    /* When */
    const stages = items.map((item) => setStage(item, 'needsYou'));

    /* Then */
    assert.deepEqual(managerCounts(stages, 'bug'), {unread: 0, urgent: 0});
    assert.deepEqual(stages[0]!.state, {kind: 'inProgress', stage: 'needsYou'});
});

test('a stage only moves an item that is in progress', () => {
    /* Given */
    const unread = arrive(issue(1))[0]!;

    /* When */
    const after = setStage(unread, 'ready');

    /* Then */
    assert.equal(after, unread);
});

test('stopping work, or a session that ends without a PR, puts the item back as read', () => {
    /* Given */
    const working = startWork(arrive(issue(1))[0]!);

    /* When */
    const back = returnToInbox(working);

    /* Then */
    assert.equal(back.state.kind, 'read');
});

test('finishing puts an item under Done from then, and settles its regression', () => {
    /* Given */
    const regressed = markRegressed(arrive(bug('e'))[0]!);

    /* When */
    const done = finish(startWork(regressed), NOW);

    /* Then */
    assert.deepEqual(done.state, {kind: 'done', at: NOW});
    assert.equal(done.signals!.regressed, false);
});

test('a regression brings a done bug back unread and urgent', () => {
    /* Given */
    const done = finish(arrive(bug('e'))[0]!, NOW - DAY);

    /* When */
    const regressed = markRegressed(done);

    /* Then */
    assert.equal(regressed.state.kind, 'unread');
    assert.deepEqual(managerCounts([regressed], 'bug'), {unread: 1, urgent: 1});
});

test('a regression on a bug being worked on keeps its stage', () => {
    /* Given */
    const working = startWork(arrive(bug('e'))[0]!, 'prCi');

    /* When */
    const regressed = markRegressed(working);

    /* Then */
    assert.deepEqual(regressed.state, {kind: 'inProgress', stage: 'prCi'});
    assert.equal(regressed.signals!.regressed, true);
});

test('a regression set by the page survives the next poll and wakes nothing twice', () => {
    /* Given */
    const regressed = markRead(markRegressed(arrive(bug('e'))[0]!));

    /* When */
    const {items} = syncSource([regressed], [bug('e')], CONTEXT);

    /* Then */
    assert.equal(items[0]!.signals!.regressed, true);
    assert.equal(items[0]!.state.kind, 'read');
});

test('notes are kept across a snooze, the backlog and a poll', () => {
    /* Given */
    const noted = setNotes(arrive(issue(1))[0]!, 'Ask Ben which export');

    /* When */
    const {items} = syncSource([toBacklog(snooze(noted, null))], [issue(1, {title: 'Edited'})], CONTEXT);

    /* Then */
    assert.equal(items[0]!.notes, 'Ask Ben which export');
});

// ── Time ──

test('a timed snooze wakes at its time, unread', () => {
    /* Given */
    const items = [
        snooze(arrive(issue(1))[0]!, NOW),
        snooze(arrive(issue(2))[0]!, NOW + 1),
        snooze(arrive(issue(3))[0]!, null),
    ];

    /* When */
    const woken = wakeDue(items, NOW);

    /* Then */
    assert.deepEqual(
        woken.map((item) => [item.key, item.state.kind]),
        [['issue:movelab/connect#1', 'unread']],
    );
});

// ── Counting ──

test('urgent counts the unread bugs that are trending or regressed', () => {
    /* Given */
    const [trending, calm, regressed] = arrive(bug('t', {events24h: 40, events7d: 50}), bug('c'), bug('r'));
    const readTrending = markRead(arrive(bug('t2', {events24h: 40, events7d: 50}))[0]!);

    /* When */
    const summary = inboxSummary([trending!, calm!, markRegressed(regressed!), readTrending, ...arrive(issue(1))], {
        bug: true,
        issue: true,
    });

    /* Then */
    assert.deepEqual(summary, {
        bug: {unread: 3, urgent: 2},
        issue: {unread: 1, urgent: 0},
        configured: {bug: true, issue: true},
    });
});

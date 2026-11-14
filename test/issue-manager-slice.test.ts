import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    initialIssueManagerState,
    issueManagerReducer,
    nextAfter,
    visibleGroups,
    visibleRows,
} from '../src/renderer/state/issue-manager-slice';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {canBacklog, issueKeyAction} from '../src/renderer/ui/issue-manager/page-keys';
import {markRead, snooze, startWork, syncSource, toBacklog} from '../src/domain/inbox/items';
import type {InboxItem} from '../src/domain/inbox/model';
import {DAY, ME, NOW, THRESHOLDS, issue} from './support/inbox-fixtures';

function items(): InboxItem[] {
    const fetched = [
        issue(1, {repository: 'b/api', updatedAt: new Date(NOW - 2 * DAY).toISOString()}),
        issue(2, {repository: 'b/api', updatedAt: new Date(NOW - DAY).toISOString()}),
        issue(3, {repository: 'a/web'}),
        issue(4, {repository: 'a/web'}),
    ];
    const context = {now: NOW, complete: true, watchingSince: NOW, thresholds: THRESHOLDS, viewer: ME};
    const [one, two, three, four] = ['b/api', 'b/api', 'a/web', 'a/web'].map(
        (_, i) => syncSource([], [fetched[i]!], context).items[0]!,
    );
    return [one!, two!, markRead(three!), startWork(four!)];
}

test('the inbox is grouped by repository, newest update first, without what is being worked on', () => {
    /* Given */
    const state = issueManagerReducer(initialIssueManagerState, {type: 'issueManagerItemsLoaded', items: items()});

    /* When */
    const groups = visibleGroups(state);

    /* Then */
    assert.deepEqual(
        groups.map((group) => [
            group.repository,
            group.items.map((item) => item.facts.kind === 'issue' && item.facts.number),
        ]),
        [
            ['a/web', [3]],
            ['b/api', [2, 1]],
        ],
    );
});

test('the Unread tile leaves the read rows out, and In progress lists the started ones', () => {
    /* Given */
    const loaded = issueManagerReducer(initialIssueManagerState, {type: 'issueManagerItemsLoaded', items: items()});

    /* When */
    const unread = issueManagerReducer(loaded, {type: 'issueManagerFilterChosen', filter: 'unread'});
    const started = issueManagerReducer(loaded, {type: 'issueManagerTabChosen', tab: 'inProgress'});

    /* Then */
    assert.equal(visibleRows(unread).length, 2);
    assert.deepEqual(
        visibleRows(started).map((item) => item.key),
        ['issue:a/web#4'],
    );
});

test('typed notes show at once on their item', () => {
    /* Given */
    const loaded = issueManagerReducer(initialIssueManagerState, {type: 'issueManagerItemsLoaded', items: items()});

    /* When */
    const typed = issueManagerReducer(loaded, {type: 'issueManagerNotesTyped', key: 'issue:b/api#1', notes: 'CSV'});

    /* Then */
    assert.equal(typed.items?.find((item) => item.key === 'issue:b/api#1')?.notes, 'CSV');
});

test('a row leaving the list hands the selection to the one after it, or before it at the end', () => {
    /* Given */
    const rows = visibleRows(
        issueManagerReducer(initialIssueManagerState, {type: 'issueManagerItemsLoaded', items: items()}),
    );

    /* When */
    const middle = nextAfter(rows, rows[1]!.key);
    const last = nextAfter(rows, rows[2]!.key);

    /* Then */
    assert.equal(middle, rows[2]!.key);
    assert.equal(last, rows[1]!.key);
});

test('keys: ⏎ starts an issue in the inbox and opens the session of a started one; S and B only in the inbox', () => {
    /* Given */
    const [unread, , , working] = items();

    /* When */
    const start = issueKeyAction('Enter', unread!);
    const open = issueKeyAction('Enter', working!);
    const snoozeWorking = issueKeyAction('s', working!);

    /* Then */
    assert.equal(start?.kind, 'start');
    assert.equal(open?.kind, 'openSession');
    assert.equal(snoozeWorking, null);
    assert.equal(issueKeyAction('M', unread!)?.kind, 'postNow');
    assert.equal(issueKeyAction('m', unread!)?.kind, 'comment');
    assert.equal(issueKeyAction('c', unread!)?.kind, 'notes');
    assert.deepEqual(issueKeyAction('j', null), {kind: 'step', step: 1});
});

test('choosing a manager on the empty screen opens its page', () => {
    /* When */
    const issue = rootReducer(initialRendererState(), {type: 'managerPageRequested', manager: 'issue'});
    const bug = rootReducer(initialRendererState(), {type: 'managerPageRequested', manager: 'bug'});

    /* Then */
    assert.deepEqual(issue.mainArea.route, {kind: 'issueManager'});
    assert.deepEqual(bug.mainArea.route, {kind: 'bugs'});
});

test('a row offers Backlog while it is in the inbox or snoozed, not once it is in the backlog or started', () => {
    /* Given */
    const [unread, , read, working] = items();
    const snoozed = snooze(unread!, null);
    const backlogged = toBacklog(unread!);

    /* When */
    const offered = [unread, read, snoozed, backlogged, working].map((item) => canBacklog(item!));

    /* Then */
    assert.deepEqual(offered, [true, true, true, false, false]);
});

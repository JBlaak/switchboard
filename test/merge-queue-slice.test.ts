/**
 * The merge queue outside the project page (#315), renderer side: the latest
 * queue and errands per repository as main pushed them, and where the session
 * header panel's buttons stand.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {initialRendererState, rootReducer} from '../src/renderer/state/root';
import {queueActionKey} from '../src/renderer/state/merge-queue-slice';
import {errand, failed, head, queued, queueOf, REPO} from './support/merge-queue-fixtures';
import type {RendererEvent} from '../src/renderer/state/events';
import type {RendererState} from '../src/renderer/state/root';
import type {MergeQueue} from '../src/domain/project/merge-queue';
import type {QueueErrandView} from '../src/domain/project/queue-errands';

function run(state: RendererState, ...events: RendererEvent[]): RendererState {
    return events.reduce((s, e) => rootReducer(Object.freeze(s), e), state);
}

const changed = (queue: MergeQueue | null, errands: QueueErrandView[] = [], repository = REPO): RendererEvent => ({
    type: 'mergeQueueChanged',
    change: {repository, queue, errands},
});

test('a pushed queue and its errands are kept per repository', () => {
    /* Given */
    const ours = queueOf([head(1), queued(2, 2)]);
    const theirs = queueOf([head(7)]);

    /* When */
    const state = run(initialRendererState(), changed(ours, [errand('s1')]), changed(theirs, [], 'o/other'));

    /* Then */
    assert.strictEqual(state.mergeQueue.queues[REPO], ours);
    assert.strictEqual(state.mergeQueue.queues['o/other'], theirs);
    assert.deepEqual(state.mergeQueue.errands[REPO], [errand('s1')]);
    assert.deepEqual(state.mergeQueue.errands['o/other'], []);
});

test('a null queue drops the repository, and dropping one that is not there changes nothing', () => {
    /* Given */
    const before = run(initialRendererState(), changed(queueOf([head(1)]), [errand('s1')]));

    /* When */
    const dropped = run(before, changed(null));
    const again = run(dropped, changed(null));

    /* Then */
    assert.deepEqual(dropped.mergeQueue.queues, {});
    assert.deepEqual(dropped.mergeQueue.errands, {});
    assert.strictEqual(again, dropped);
});

test('a header panel action is busy until main answers, then says what it came to', () => {
    /* Given */
    const key = queueActionKey(REPO, 4);
    const start: RendererEvent = {type: 'queuePanelActionStarted', repository: REPO, number: 4, action: 'fix'};

    /* When */
    const busy = run(initialRendererState(), start);
    const done = run(busy, {
        type: 'queuePanelActionFinished',
        repository: REPO,
        number: 4,
        action: 'fix',
        ok: true,
        text: 'Sent to this session',
    });

    /* Then */
    assert.deepEqual(busy.mergeQueue.actions[key], {phase: 'busy', action: 'fix'});
    assert.deepEqual(done.mergeQueue.actions[key], {phase: 'done', action: 'fix', text: 'Sent to this session'});
});

test('a finished action is forgotten once its PR is no longer out of the queue; a busy one stays', () => {
    /* Given */
    const outOfQueue = run(
        initialRendererState(),
        changed(queueOf([head(1), failed(4), failed(5)])),
        {type: 'queuePanelActionFinished', repository: REPO, number: 4, action: 'retry', ok: true, text: 'Back'},
        {type: 'queuePanelActionStarted', repository: REPO, number: 5, action: 'fix'},
    );

    /* When */
    const stillOut = run(outOfQueue, changed(queueOf([head(1), failed(4), failed(5)])));
    const rejoined = run(outOfQueue, changed(queueOf([head(1), queued(4, 2), queued(5, 3)])));

    /* Then */
    assert.ok(stillOut.mergeQueue.actions[queueActionKey(REPO, 4)]);
    assert.equal(rejoined.mergeQueue.actions[queueActionKey(REPO, 4)], undefined);
    assert.deepEqual(rejoined.mergeQueue.actions[queueActionKey(REPO, 5)], {phase: 'busy', action: 'fix'});
});

test('an errand’s session re-keyed by a fork stays the errand’s', () => {
    /* Given */
    const before = run(initialRendererState(), changed(queueOf([head(1)]), [errand('s1'), errand('s2')]));

    /* When */
    const state = run(before, {type: 'sessionForked', oldId: 's1', newId: 's1b'});

    /* Then */
    assert.deepEqual(
        state.mergeQueue.errands[REPO].map((view) => view.sessionId),
        ['s1b', 's2'],
    );
});

test('events about anything else leave the slice as it was', () => {
    /* Given */
    const before = run(initialRendererState(), changed(queueOf([head(1)])));

    /* When */
    const state = run(before, {type: 'sessionForked', oldId: 'x', newId: 'y'}, {type: 'projectsChanged'});

    /* Then */
    assert.strictEqual(state.mergeQueue, before.mergeQueue);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {PinOrderService} from '../src/application/services/pin-order-service';
import {SessionMetaService} from '../src/application/services/session-meta-service';
import type {PinRef} from '../src/domain/pin/pin-order';
import type {CachedSession, SessionMeta} from '../src/domain/session/session';

/** The service over an in-memory store, with the search titles it wrote. */
function harness(summary = 'Fix the login page') {
    const metas = new Map<string, SessionMeta>();
    const metaOf = (sessionId: string): SessionMeta =>
        metas.get(sessionId) ?? {sessionId, name: null, starred: 0, archived: 0, snoozedUntil: null};
    const toggles: string[] = [];
    const titles: [string, string][] = [];
    /** Pinned's order, as the pin-order service stores it. */
    const pinned: PinRef[] = [];
    const service = new SessionMetaService({
        repository: {
            setName: (sessionId, name) => void metas.set(sessionId, {...metaOf(sessionId), name}),
            getCachedSession: (sessionId) => ({sessionId, summary}) as CachedSession,
            getMeta: (sessionId) => metas.get(sessionId) ?? null,
            toggleStar: (sessionId) => {
                toggles.push(sessionId);
                const starred = metaOf(sessionId).starred ? 0 : 1;
                metas.set(sessionId, {...metaOf(sessionId), starred});
                return starred;
            },
            setArchived: (sessionId, archived) =>
                void metas.set(sessionId, {...metaOf(sessionId), archived: archived ? 1 : 0}),
        },
        pinOrder: new PinOrderService({
            getPinOrder: () => pinned.filter((ref) => ref.kind === 'session'),
            setPinOrder: (order) => void pinned.splice(0, pinned.length, ...order),
        }),
        searchIndex: {updateTitle: (id, _type, title) => void titles.push([id, title])},
    });
    return {service, metas, metaOf, toggles, titles, pinned};
}

test('a rename stores the name and puts it in front of the summary in the search title', () => {
    /* Given */
    const h = harness();

    /* When */
    const result = h.service.rename('s1', 'Login');

    /* Then */
    assert.deepEqual(result, {name: 'Login'});
    assert.equal(h.metaOf('s1').name, 'Login');
    assert.deepEqual(h.titles, [['s1', 'Login Fix the login page']]);
});

test('an empty rename clears the name', () => {
    /* Given */
    const h = harness();
    h.service.rename('s1', 'Login');

    /* When */
    const result = h.service.rename('s1', '');

    /* Then */
    assert.deepEqual(result, {name: null});
    assert.equal(h.metaOf('s1').name, null);
});

test('setting the pin it already has changes nothing', () => {
    /* Given */
    const h = harness();
    h.service.setPinned('s1', true);

    /* When */
    const starred = h.service.setPinned('s1', true);

    /* Then */
    assert.equal(starred, 1);
    assert.deepEqual(h.toggles, ['s1']);
});

test('unpinning a pinned session takes its star', () => {
    /* Given */
    const h = harness();
    h.service.toggleStar('s1');

    /* When */
    const starred = h.service.setPinned('s1', false);

    /* Then */
    assert.equal(starred, 0);
    assert.equal(h.metaOf('s1').starred, 0);
});

test('unarchive brings the row back', () => {
    /* Given */
    const h = harness();
    h.metas.set('s1', {...h.metaOf('s1'), archived: 1});

    /* When */
    h.service.unarchive('s1');

    /* Then */
    assert.equal(h.metaOf('s1').archived, 0);
});

test('a pin from either side lands at the end of Pinned, and an unpin takes it out', () => {
    /* Given */
    const h = harness();
    h.service.toggleStar('mac');

    /* When */
    h.service.setPinned('phone', true);
    const {order} = h.service.toggleStar('mac');

    /* Then */
    assert.deepEqual(h.pinned, [{kind: 'session', sessionId: 'phone'}]);
    assert.deepEqual(order, [{kind: 'session', sessionId: 'phone'}]);
});

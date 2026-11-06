import {test} from 'node:test';
import assert from 'node:assert/strict';
import {UNSENT_TEXT, bannerFor, bannerSeenFor, withSeen} from '../src/renderer/features/grill/grill-banner';
import {question, view} from './support/grill-views';

/** A second revision: Q2 changed, Q4 new, one dropped. */
function revised() {
    return view(0, {
        revision: 2,
        dropped: 1,
        questions: [question(1), question(2, {mark: 'changed'}), question(3), question(4, {mark: 'new'})],
    });
}

test('the round as first posted has no banner', () => {
    /* Given */
    const v = view(3);

    /* When */
    const banner = bannerFor(v, null);

    /* Then */
    assert.equal(banner, null);
});

test('a revision counts what it changed, added and dropped', () => {
    /* Given */
    const v = revised();

    /* When */
    const banner = bannerFor(v, null);

    /* Then */
    assert.deepEqual(banner, {kind: 'revised', text: 'Claude revised the round: 1 changed, 1 new, 1 dropped.'});
});

test('a revision that only dropped questions says so', () => {
    /* Given */
    const v = view(2, {revision: 1, dropped: 2});

    /* When */
    const banner = bannerFor(v, null);

    /* Then */
    assert.deepEqual(banner, {kind: 'revised', text: 'Claude revised the round: 2 dropped.'});
});

test('the banner stays while a marked question has not been in view', () => {
    /* Given */
    const v = revised();
    const seen = withSeen(bannerSeenFor(null, 2), 1);

    /* When */
    const banner = bannerFor(v, seen);

    /* Then */
    assert.equal(banner?.kind, 'revised');
});

test('the banner goes once every marked question has been in view', () => {
    /* Given */
    const v = revised();
    const seen = withSeen(withSeen(bannerSeenFor(null, 2), 1), 3);

    /* When */
    const banner = bannerFor(v, seen);

    /* Then */
    assert.equal(banner, null);
});

test('a dismissed banner stays dismissed for its revision', () => {
    /* Given */
    const v = revised();
    const seen = {...bannerSeenFor(null, 2), dismissed: true};

    /* When */
    const banner = bannerFor(v, seen);

    /* Then */
    assert.equal(banner, null);
});

test('the next revision brings the banner back', () => {
    /* Given */
    const dismissedEarlier = {revision: 1, dismissed: true, seen: [1, 3]};
    const v = revised();

    /* When */
    const banner = bannerFor(v, dismissedEarlier);

    /* Then */
    assert.equal(banner?.kind, 'revised');
});

test('a send a revision cancelled is said over anything else, even once dismissed', () => {
    /* Given */
    const v = {...revised(), send: 'unsent' as const};
    const seen = {...bannerSeenFor(null, 2), dismissed: true};

    /* When */
    const banner = bannerFor(v, seen);

    /* Then */
    assert.deepEqual(banner, {kind: 'unsent', text: UNSENT_TEXT});
});

test('seeing a question twice records it once', () => {
    /* Given */
    const once = withSeen(bannerSeenFor(null, 1), 2);

    /* When */
    const twice = withSeen(once, 2);

    /* Then */
    assert.strictEqual(twice, once);
});

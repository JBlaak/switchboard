/**
 * The Land it rocket's flight: how far it climbs, the arc it follows and how
 * it leans into it.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rocketClimb, rocketLean, rocketPath} from '../src/renderer/lib/motion/rocket';

test('the rocket starts on the pad and ends the climb up and to the right', () => {
    /* Given */
    const climb = 500;

    /* When */
    const start = rocketPath(0, climb);
    const end = rocketPath(1, climb);

    /* Then */
    assert.deepEqual(start, {dx: 0, dy: -0});
    assert.equal(end.dy, -500);
    assert.ok(end.dx > 0);
});

test('the rocket speeds up as it climbs', () => {
    /* Given */
    const climb = 500;

    /* When */
    const firstHalf = -rocketPath(0.5, climb).dy;
    const secondHalf = -rocketPath(1, climb).dy - firstHalf;

    /* Then */
    assert.ok(secondHalf > firstHalf * 3);
});

test('a rocket launched low in the window climbs past its top', () => {
    /* Given */
    const y = 800;

    /* When */
    const climb = rocketClimb(y);

    /* Then */
    assert.ok(climb > y);
});

test('a rocket launched near the top still climbs a fair way', () => {
    /* Given */
    const y = 40;

    /* When */
    const climb = rocketClimb(y);

    /* Then */
    assert.equal(climb, 360);
});

test('the rocket stands straight at lift-off and leans right along its arc, but never far', () => {
    /* Given */
    const climb = 500;

    /* When */
    const leans = [0, 0.1, 0.3, 0.6, 0.9].map((t) => rocketLean(t, climb));

    /* Then */
    assert.equal(leans[0], 0);
    for (const lean of leans.slice(1)) {
        assert.ok(lean > 0);
        assert.ok(lean <= 0.5);
    }
});

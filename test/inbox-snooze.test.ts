/**
 * The managers' snooze options (#412): a pure function of now and the cycle
 * the Planner says today is in. Times are local, so the tests hold in any
 * time zone. November 2026 runs Mon 2 … Sun 8, Mon 9 … Sun 15.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inboxSnoozeOptions} from '../src/domain/inbox/snooze';
import {toCycle} from '../src/domain/inbox/cycle';
import type {Cycle} from '../src/domain/inbox/cycle';
import cycles from './fixtures/planner-cycles.json';

const CYCLE_41 = toCycle(cycles['41'])!;
const CYCLE_42 = toCycle(cycles['42'])!;

const local = (month: number, day: number, hours = 14): Date => new Date(2026, month - 1, day, hours);
const nov = (day: number, hours = 14): Date => local(11, day, hours);

/** The options as `label → "Wed 11 Nov 09:00"`, or `—` for Until it changes. */
function offered(now: Date, cycle: Cycle | null = null): Record<string, string> {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return Object.fromEntries(
        inboxSnoozeOptions(now, cycle).map(({label, until}) => [
            label,
            until
                ? `${until.toDateString().slice(0, 3)} ${until.getDate()} ${until.toDateString().slice(4, 7)} ${pad(until.getHours())}:${pad(until.getMinutes())}`
                : '—',
        ]),
    );
}

test('on a Monday later this week lands on Wednesday at nine', () => {
    /* When */
    const options = offered(nov(9));

    /* Then */
    assert.equal(options['Later this week'], 'Wed 11 Nov 09:00');
});

test('on a Tuesday later this week lands on Thursday at nine', () => {
    /* When */
    const options = offered(nov(10));

    /* Then */
    assert.equal(options['Later this week'], 'Thu 12 Nov 09:00');
});

test('on a Wednesday later this week lands on Friday at nine', () => {
    /* When */
    const options = offered(nov(11));

    /* Then */
    assert.equal(options['Later this week'], 'Fri 13 Nov 09:00');
});

for (const [weekday, day] of [
    ['Thursday', 12],
    ['Friday', 13],
    ['Saturday', 14],
    ['Sunday', 15],
] as const) {
    test(`on a ${weekday} later this week is not offered`, () => {
        /* When */
        const options = offered(nov(day));

        /* Then */
        assert.equal('Later this week' in options, false);
    });
}

test('without a cycle the options are tomorrow, later this week, a week and until it changes', () => {
    /* When */
    const options = offered(nov(9, 22));

    /* Then */
    assert.deepEqual(options, {
        Tomorrow: 'Tue 10 Nov 09:00',
        'Later this week': 'Wed 11 Nov 09:00',
        '1 week': 'Mon 16 Nov 09:00',
        'Until it changes': '—',
    });
});

test('until it changes has no date', () => {
    /* When */
    const option = inboxSnoozeOptions(nov(13), null).find((o) => o.kind === 'untilChanged');

    /* Then */
    assert.equal(option?.until, null);
});

test('with a cycle its last week, the cooldown after it and the next cycle’s build follow, each a Monday at nine', () => {
    /* When */
    const options = offered(nov(13), CYCLE_42);

    /* Then */
    assert.deepEqual(options, {
        Tomorrow: 'Sat 14 Nov 09:00',
        '1 week': 'Fri 20 Nov 09:00',
        'Until it changes': '—',
        'Last week of this cycle': 'Mon 14 Dec 09:00',
        'Upcoming cooldown week': 'Mon 21 Dec 09:00',
        'Next cycle': 'Mon 28 Dec 09:00',
    });
});

test('the cycle options are marked as the Planner’s', () => {
    /* When */
    const options = inboxSnoozeOptions(nov(13), CYCLE_42);

    /* Then */
    assert.deepEqual(
        options.filter((o) => o.cycle).map((o) => o.kind),
        ['lastWeekOfCycle', 'cooldown', 'nextCycle'],
    );
});

test('in a cycle’s last week its last week is no longer offered', () => {
    /* When */
    const options = offered(local(10, 30), CYCLE_41);

    /* Then */
    assert.deepEqual(options, {
        Tomorrow: 'Sat 31 Oct 09:00',
        '1 week': 'Fri 6 Nov 09:00',
        'Until it changes': '—',
        'Upcoming cooldown week': 'Mon 2 Nov 09:00',
        'Next cycle': 'Mon 9 Nov 09:00',
    });
});

test('on the Monday a cycle’s last week starts it is no longer offered', () => {
    /* When */
    const options = offered(local(10, 26), CYCLE_41);

    /* Then */
    assert.equal('Last week of this cycle' in options, false);
    assert.equal(options['Upcoming cooldown week'], 'Mon 2 Nov 09:00');
});

test('on the first day of the next cycle its own dates are offered', () => {
    /* When */
    const options = offered(nov(2), CYCLE_42);

    /* Then */
    assert.equal(options['Last week of this cycle'], 'Mon 14 Dec 09:00');
    assert.equal(options['Upcoming cooldown week'], 'Mon 21 Dec 09:00');
    assert.equal(options['Next cycle'], 'Mon 28 Dec 09:00');
});

test('later this week runs into the next month', () => {
    /* When */
    const options = offered(local(9, 30));

    /* Then */
    assert.equal(options['Later this week'], 'Fri 2 Oct 09:00');
});

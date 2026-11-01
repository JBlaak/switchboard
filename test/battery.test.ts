import {test} from 'node:test';
import assert from 'node:assert/strict';

import {parsePmsetBattery} from '../src/domain/power/battery';

const BATT = (source: string, line: string): string => [`Now drawing from '${source}'`, line].join('\n');

test('reads the level and charging from a MacBook on the charger', () => {
    /* Given */
    const output = BATT('AC Power', ' -InternalBattery-0 (id=22478947)\t37%; charging; 1:47 remaining present: true');

    /* When */
    const battery = parsePmsetBattery(output);

    /* Then */
    assert.deepEqual(battery, {percent: 37, charging: true});
});

test('reads a MacBook running on its battery as not charging', () => {
    /* Given */
    const output = BATT(
        'Battery Power',
        ' -InternalBattery-0 (id=22478947)\t85%; discharging; 5:12 remaining present: true',
    );

    /* When */
    const battery = parsePmsetBattery(output);

    /* Then */
    assert.deepEqual(battery, {percent: 85, charging: false});
});

test('reads a full battery on the charger as not charging', () => {
    /* Given */
    const output = BATT('AC Power', ' -InternalBattery-0 (id=22478947)\t100%; charged; 0:00 remaining present: true');

    /* When */
    const battery = parsePmsetBattery(output);

    /* Then */
    assert.deepEqual(battery, {percent: 100, charging: false});
});

test('reads "finishing charge" as charging', () => {
    /* Given */
    const output = BATT(
        'AC Power',
        ' -InternalBattery-0 (id=22478947)\t98%; finishing charge; 0:10 remaining present: true',
    );

    /* When */
    const battery = parsePmsetBattery(output);

    /* Then */
    assert.deepEqual(battery, {percent: 98, charging: true});
});

test('a Mac without a battery has none', () => {
    /* Given */
    const output = "Now drawing from 'AC Power'\n";

    /* When */
    const battery = parsePmsetBattery(output);

    /* Then */
    assert.equal(battery, null);
});

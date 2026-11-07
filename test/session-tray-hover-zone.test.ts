import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TRAY_ZONE_PX, inTerminalTopZone} from '../src/renderer/ui/session-tray/hover-zone';

const terminal = {left: 200, right: 1000, top: 40, bottom: 800};

test('the top of the terminal opens the tray', () => {
    /* Given */
    const y = terminal.top + TRAY_ZONE_PX - 1;

    /* When */
    const inZone = inTerminalTopZone(600, y, terminal);

    /* Then */
    assert.equal(inZone, true);
});

test('the terminal below the top band does not', () => {
    /* Given */
    const y = terminal.top + TRAY_ZONE_PX;

    /* When */
    const inZone = inTerminalTopZone(600, y, terminal);

    /* Then */
    assert.equal(inZone, false);
});

test('beside the terminal, at the same height, does not', () => {
    /* Given */
    const x = terminal.left - 1;

    /* When */
    const inZone = inTerminalTopZone(x, terminal.top + 10, terminal);

    /* Then */
    assert.equal(inZone, false);
});

test('a hidden terminal has no zone', () => {
    /* Given */
    const hidden = {left: 0, right: 0, top: 0, bottom: 0};

    /* When */
    const inZone = inTerminalTopZone(0, 0, hidden);

    /* Then */
    assert.equal(inZone, false);
});

test('a terminal shorter than the band is all zone, and no more', () => {
    /* Given */
    const short = {...terminal, bottom: terminal.top + 60};

    /* When */
    const inside = inTerminalTopZone(600, short.bottom - 1, short);
    const below = inTerminalTopZone(600, short.bottom, short);

    /* Then */
    assert.equal(inside, true);
    assert.equal(below, false);
});

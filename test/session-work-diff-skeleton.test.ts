import {test} from 'node:test';
import assert from 'node:assert/strict';

import {SKELETON_CARDS} from '../src/renderer/ui/session-work/support/diff-skeleton';

test('the diff skeleton draws a few file cards of 6 to 9 lines each', () => {
    /* Given */
    const cards = SKELETON_CARDS;

    /* When */
    const lineCounts = cards.map((card) => card.lines.length);

    /* Then */
    assert.ok(cards.length >= 2 && cards.length <= 4);
    for (const count of lineCounts) assert.ok(count >= 6 && count <= 9, `${count} lines`);
});

test('every skeleton card tints a couple of lines as an addition or a deletion', () => {
    /* Given */
    const cards = SKELETON_CARDS;

    /* When */
    const tinted = cards.map((card) => card.lines.filter((line) => line.kind !== 'context').length);

    /* Then */
    for (const count of tinted) assert.ok(count >= 1 && count <= 3, `${count} tinted lines`);
    assert.ok(cards.some((card) => card.lines.some((line) => line.kind === 'add')));
    assert.ok(cards.some((card) => card.lines.some((line) => line.kind === 'delete')));
});

test('the skeleton widths stay inside their line and vary like code', () => {
    /* Given */
    const lines = SKELETON_CARDS.flatMap((card) => card.lines);

    /* When */
    const widths = new Set(lines.map((line) => line.width));

    /* Then */
    for (const card of SKELETON_CARDS) assert.ok(card.path > 0 && card.path <= 60);
    for (const line of lines) {
        assert.ok(line.width > 0 && line.width <= 80, `width ${line.width}`);
        assert.ok(line.indent >= 0 && line.indent % 4 === 0, `indent ${line.indent}`);
    }
    assert.ok(widths.size > lines.length / 2, 'widths repeat too often');
});

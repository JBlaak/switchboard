import {test} from 'node:test';
import assert from 'node:assert/strict';

import {refinementFromOmnidiff} from '../src/domain/session-work/refinement';

type Hunk = {
    operation: string;
    range: {start_row: number; start_column: number; end_row: number; end_column: number};
    move_target?: {start_row: number; start_column: number; end_row: number; end_column: number};
};

function range(startRow: number, startColumn: number, endRow: number, endColumn: number) {
    return {start_row: startRow, start_column: startColumn, end_row: endRow, end_column: endColumn};
}

/** OmniDiff's JSON for one diff, as `--mode json --minimal` prints it. */
function output(before: Hunk[], after: Hunk[], extra: Record<string, unknown> = {}) {
    return {
        before: {path: '/t/before/a.ts', language: 'TypeScript', hunks: before},
        after: {path: '/t/after/a.ts', language: 'TypeScript', hunks: after},
        large_residual: false,
        ...extra,
    };
}

const BEFORE = ['let sum = 0;', '    sum += item.price;', ''].join('\n');
const AFTER = ['const sum = 0;', '    sum += item.price * item.quantity;', ''].join('\n');

test('a change within one line is a mark on that line, by its 1-based number', () => {
    /* Given */
    const json = output(
        [{operation: 'update', range: range(0, 0, 0, 3)}],
        [
            {operation: 'update', range: range(0, 0, 0, 5)},
            {operation: 'insert', range: range(1, 21, 1, 37)},
        ],
    );

    /* When */
    const refinement = refinementFromOmnidiff(json, BEFORE, AFTER);

    /* Then */
    assert.deepEqual(refinement, {
        summary: null,
        before: {1: [{start: 0, end: 3, kind: 'update'}]},
        after: {
            1: [{start: 0, end: 5, kind: 'update'}],
            2: [{start: 21, end: 37, kind: 'insert'}],
        },
    });
    assert.equal(AFTER.split('\n')[1].slice(21, 37), ' * item.quantity');
});

test('a range over several rows marks each: the first from its column, the middle whole, the last up to its column', () => {
    /* Given */
    const after = ['const a = [', '    1,', '    2,', '];', ''].join('\n');
    const json = output([], [{operation: 'insert', range: range(0, 10, 3, 1)}]);

    /* When */
    const refinement = refinementFromOmnidiff(json, '', after);

    /* Then */
    assert.deepEqual(refinement?.after, {
        1: [{start: 10, end: 11, kind: 'insert'}],
        2: [{start: 0, end: 6, kind: 'insert'}],
        3: [{start: 0, end: 6, kind: 'insert'}],
        4: [{start: 0, end: 1, kind: 'insert'}],
    });
});

test('a range that ends at column 0 of the next row marks only up to the end of its line', () => {
    /* Given */
    const json = output([{operation: 'delete', range: range(1, 4, 2, 0)}], []);

    /* When */
    const refinement = refinementFromOmnidiff(json, BEFORE, AFTER);

    /* Then */
    assert.deepEqual(refinement?.before, {2: [{start: 4, end: 22, kind: 'delete'}]});
});

test('a move names the line on the other side it moved to', () => {
    /* Given */
    const json = output(
        [{operation: 'move', range: range(1, 4, 1, 21), move_target: range(1, 4, 1, 21)}],
        [{operation: 'move', range: range(1, 4, 1, 21), move_target: range(1, 4, 1, 21)}],
    );

    /* When */
    const refinement = refinementFromOmnidiff(json, BEFORE, AFTER);

    /* Then */
    assert.deepEqual(refinement?.before[2], [{start: 4, end: 21, kind: 'move', otherLine: 2}]);
    assert.deepEqual(refinement?.after[2], [{start: 4, end: 21, kind: 'move', otherLine: 2}]);
});

test('byte columns become UTF-16 columns past é, an emoji and CJK', () => {
    /* Given */
    // é is 2 bytes and 1 unit, 😀 is 4 bytes and 2 units, 世 is 3 bytes and 1 unit.
    const after = 'const g = "héllo 😀 世界!";\n';
    const bang = Buffer.byteLength('const g = "héllo 😀 世界');
    const json = output([], [{operation: 'insert', range: range(0, bang, 0, bang + 1)}]);

    /* When */
    const refinement = refinementFromOmnidiff(json, '', after);

    /* Then */
    const [mark] = refinement!.after[1];
    assert.equal(after.slice(mark.start, mark.end), '!');
    assert.deepEqual(mark, {start: 22, end: 23, kind: 'insert'});
});

test('a mark around an emoji covers both of its UTF-16 units', () => {
    /* Given */
    const after = 'a😀b\n';
    const json = output([], [{operation: 'update', range: range(0, 1, 0, 5)}]);

    /* When */
    const refinement = refinementFromOmnidiff(json, '', after);

    /* Then */
    assert.deepEqual(refinement?.after[1], [{start: 1, end: 3, kind: 'update'}]);
});

test('columns past the end of a line, and rows past the end of the file, are clamped or dropped', () => {
    /* Given */
    const json = output(
        [],
        [
            {operation: 'insert', range: range(0, 2, 0, 999)},
            {operation: 'insert', range: range(40, 0, 41, 3)},
            {operation: 'insert', range: range(1, 900, 1, 999)},
        ],
    );

    /* When */
    const refinement = refinementFromOmnidiff(json, '', 'abcd\nef\n');

    /* Then */
    assert.deepEqual(refinement?.after, {1: [{start: 2, end: 4, kind: 'insert'}]});
});

test("each line's marks are in column order", () => {
    /* Given */
    const json = output(
        [],
        [
            {operation: 'insert', range: range(1, 21, 1, 37)},
            {operation: 'update', range: range(1, 4, 1, 7)},
        ],
    );

    /* When */
    const refinement = refinementFromOmnidiff(json, BEFORE, AFTER);

    /* Then */
    assert.deepEqual(
        refinement?.after[2].map((mark) => mark.start),
        [4, 21],
    );
});

test("a CRLF line's columns count as git's line does, and its \\r is never marked", () => {
    /* Given */
    const after = 'let x = 1;\r\nlet y = 2;\r\n';
    const json = output([], [{operation: 'insert', range: range(0, 4, 1, 0)}]);

    /* When */
    const refinement = refinementFromOmnidiff(json, '', after);

    /* Then */
    assert.deepEqual(refinement?.after, {1: [{start: 4, end: 10, kind: 'insert'}]});
});

test('a summary OmniDiff names is passed through, and an unknown one is null', () => {
    /* Given */
    const known = output([], [], {summary: 'whitespace_only'});
    const unknown = output([], [], {summary: 'something_new'});

    /* When */
    const named = refinementFromOmnidiff(known, BEFORE, AFTER);
    const unnamed = refinementFromOmnidiff(unknown, BEFORE, AFTER);

    /* Then */
    assert.equal(named?.summary, 'whitespace_only');
    assert.equal(unnamed?.summary, null);
});

test('a binary pair has no refinement', () => {
    /* Given */
    const json = output([], [], {binary: true});

    /* When */
    const refinement = refinementFromOmnidiff(json, BEFORE, AFTER);

    /* Then */
    assert.equal(refinement, null);
});

test('anything but OmniDiff JSON has no refinement', () => {
    /* Given */
    const garbage: unknown[] = [
        null,
        'text',
        42,
        [],
        {},
        {before: {hunks: []}},
        {before: {hunks: []}, after: {hunks: 'no'}},
        output([], [{operation: 'teleport', range: range(0, 0, 0, 1)}]),
        output([], [{operation: 'insert', range: range(0, -1, 0, 1)}]),
        output([], [{operation: 'insert', range: range(0, 1.5, 0, 2)}]),
        output([], [{operation: 'insert', range: range(2, 0, 1, 0)}]),
        output([], [{operation: 'insert', range: range(0, 5, 0, 2)}]),
        output([], [{operation: 'insert'} as Hunk]),
        output([], [{operation: 'move', range: range(0, 0, 0, 1), move_target: 'there' as never}]),
    ];

    /* When */
    const refinements = garbage.map((json) => refinementFromOmnidiff(json, BEFORE, AFTER));

    /* Then */
    assert.deepEqual(
        refinements,
        garbage.map(() => null),
    );
});

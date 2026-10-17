import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseUnifiedDiff } from '../src/domain/session-work/diff';
import {
  hunkHeader, lineNumberDigits, pairLines, splitRows, unifiedRows,
} from '../src/domain/session-work/diff-layout';
import type { DiffLine } from '../src/domain/session-work/model';

const ctx = (n: number, text = 'c' + n): DiffLine => ({ kind: 'context', text, oldLine: n, newLine: n });
const del = (n: number, text = 'd' + n): DiffLine => ({ kind: 'delete', text, oldLine: n, newLine: null });
const add = (n: number, text = 'a' + n): DiffLine => ({ kind: 'add', text, oldLine: null, newLine: n });

/** A pair as `left|right` texts, `_` for a blank cell. */
const picture = (pairs: ReturnType<typeof pairLines>) =>
  pairs.map(({ left, right }) => `${left?.text ?? '_'}|${right?.text ?? '_'}`);

test('split: a context line sits on both sides', () => {
  const pairs = pairLines([ctx(1), ctx(2)]);
  assert.deepEqual(picture(pairs), ['c1|c1', 'c2|c2']);
  assert.equal(pairs[0].left, pairs[0].right);
});

test('split: a run of deletions pairs row by row with the additions after it', () => {
  assert.deepEqual(picture(pairLines([ctx(1), del(2), del(3), add(2), add(3), ctx(4)])), [
    'c1|c1', 'd2|a2', 'd3|a3', 'c4|c4',
  ]);
});

test('split: the shorter side of a change is padded with blank cells', () => {
  assert.deepEqual(picture(pairLines([del(1), del(2), del(3), add(1), ctx(4)])), ['d1|a1', 'd2|_', 'd3|_', 'c4|c4']);
  assert.deepEqual(picture(pairLines([del(1), add(1), add(2), add(3)])), ['d1|a1', '_|a2', '_|a3']);
});

test('split: only deletions, or only additions, have one side blank throughout', () => {
  assert.deepEqual(picture(pairLines([ctx(1), del(2), del(3), ctx(4)])), ['c1|c1', 'd2|_', 'd3|_', 'c4|c4']);
  assert.deepEqual(picture(pairLines([add(1), add(2)])), ['_|a1', '_|a2']);
});

test('split: separate changes in one hunk pair separately', () => {
  assert.deepEqual(picture(pairLines([del(1), add(1), ctx(2), del(3), add(3), add(4)])), [
    'd1|a1', 'c2|c2', 'd3|a3', '_|a4',
  ]);
});

test('split: an addition written before its deletion still pairs with it', () => {
  assert.deepEqual(picture(pairLines([add(1), del(1)])), ['d1|a1']);
});

test('split: nothing in, nothing out', () => {
  assert.deepEqual(pairLines([]), []);
});

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@ export function a() {',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -98,2 +98,3 @@',
  ' ninety-eight',
  '+ninety-eight and a half',
  ' ninety-nine',
  '',
].join('\n');

test('rows: unified is each hunk header followed by its lines, in diff order', () => {
  const [file] = parseUnifiedDiff(DIFF);
  const rows = unifiedRows(file);
  assert.deepEqual(rows.map((row) => (row.kind === 'hunk' ? '@@' : row.line.kind[0] + row.line.text)), [
    '@@', 'cone', 'dtwo', 'aTWO', 'cthree',
    '@@', 'cninety-eight', 'aninety-eight and a half', 'cninety-nine',
  ]);
});

test('rows: split pairs each hunk\'s lines under its header', () => {
  const [file] = parseUnifiedDiff(DIFF);
  const rows = splitRows(file);
  assert.deepEqual(rows.map((row) => (row.kind === 'hunk' ? '@@' : `${row.left?.text ?? '_'}|${row.right?.text ?? '_'}`)), [
    '@@', 'one|one', 'two|TWO', 'three|three',
    '@@', 'ninety-eight|ninety-eight', '_|ninety-eight and a half', 'ninety-nine|ninety-nine',
  ]);
});

test('hunk headers read as git wrote them, single-line ranges without a count', () => {
  const [file] = parseUnifiedDiff(DIFF);
  assert.equal(hunkHeader(file.hunks[0]), '@@ -1,3 +1,3 @@ export function a() {');
  assert.equal(hunkHeader(file.hunks[1]), '@@ -98,2 +98,3 @@');
  assert.equal(hunkHeader({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: '', lines: [] }), '@@ -0,0 +1 @@');
});

test('the line-number gutter is as wide as the largest number in the file', () => {
  const [file] = parseUnifiedDiff(DIFF);
  assert.equal(lineNumberDigits(file), 3, 'line 101 is the furthest a hunk reaches');
  assert.equal(lineNumberDigits({ hunks: [] }), 1);
});

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
  /* When */
  const pairs = pairLines([ctx(1), ctx(2)]);

  /* Then */
  assert.deepEqual(picture(pairs), ['c1|c1', 'c2|c2']);
  assert.equal(pairs[0].left, pairs[0].right);
});

test('split: a run of deletions pairs row by row with the additions after it', () => {
  /* When */
  const pairs = pairLines([ctx(1), del(2), del(3), add(2), add(3), ctx(4)]);

  /* Then */
  assert.deepEqual(picture(pairs), ['c1|c1', 'd2|a2', 'd3|a3', 'c4|c4']);
});

test('split: the shorter side of a change is padded with blank cells', () => {
  /* Given */
  const cases: Array<[DiffLine[], string[]]> = [
    [[del(1), del(2), del(3), add(1), ctx(4)], ['d1|a1', 'd2|_', 'd3|_', 'c4|c4']],
    [[del(1), add(1), add(2), add(3)], ['d1|a1', '_|a2', '_|a3']],
  ];

  for (const [lines, expected] of cases) {
    /* When */
    const pairs = pairLines(lines);

    /* Then */
    assert.deepEqual(picture(pairs), expected);
  }
});

test('split: only deletions have the right side blank throughout', () => {
  /* When */
  const pairs = pairLines([ctx(1), del(2), del(3), ctx(4)]);

  /* Then */
  assert.deepEqual(picture(pairs), ['c1|c1', 'd2|_', 'd3|_', 'c4|c4']);
});

test('split: only additions have the left side blank throughout', () => {
  /* When */
  const pairs = pairLines([add(1), add(2)]);

  /* Then */
  assert.deepEqual(picture(pairs), ['_|a1', '_|a2']);
});

test('split: separate changes in one hunk pair separately', () => {
  /* When */
  const pairs = pairLines([del(1), add(1), ctx(2), del(3), add(3), add(4)]);

  /* Then */
  assert.deepEqual(picture(pairs), ['d1|a1', 'c2|c2', 'd3|a3', '_|a4']);
});

test('split: an addition written before its deletion still pairs with it', () => {
  /* When */
  const pairs = pairLines([add(1), del(1)]);

  /* Then */
  assert.deepEqual(picture(pairs), ['d1|a1']);
});

test('split: nothing in, nothing out', () => {
  /* When */
  const pairs = pairLines([]);

  /* Then */
  assert.deepEqual(pairs, []);
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
  /* Given */
  const [file] = parseUnifiedDiff(DIFF);

  /* When */
  const rows = unifiedRows(file);

  /* Then */
  assert.deepEqual(rows.map((row) => (row.kind === 'hunk' ? '@@' : row.line.kind[0] + row.line.text)), [
    '@@', 'cone', 'dtwo', 'aTWO', 'cthree',
    '@@', 'cninety-eight', 'aninety-eight and a half', 'cninety-nine',
  ]);
});

test('rows: split pairs each hunk\'s lines under its header', () => {
  /* Given */
  const [file] = parseUnifiedDiff(DIFF);

  /* When */
  const rows = splitRows(file);

  /* Then */
  assert.deepEqual(rows.map((row) => (row.kind === 'hunk' ? '@@' : `${row.left?.text ?? '_'}|${row.right?.text ?? '_'}`)), [
    '@@', 'one|one', 'two|TWO', 'three|three',
    '@@', 'ninety-eight|ninety-eight', '_|ninety-eight and a half', 'ninety-nine|ninety-nine',
  ]);
});

test('hunk headers read as git wrote them', () => {
  /* Given */
  const [file] = parseUnifiedDiff(DIFF);

  /* When */
  const headers = file.hunks.map(hunkHeader);

  /* Then */
  assert.deepEqual(headers, ['@@ -1,3 +1,3 @@ export function a() {', '@@ -98,2 +98,3 @@']);
});

test('hunk headers write single-line ranges without a count', () => {
  /* When */
  const header = hunkHeader({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, section: '', lines: [] });

  /* Then */
  assert.equal(header, '@@ -0,0 +1 @@');
});

test('the line-number gutter is as wide as the largest number in the file', () => {
  /* Given */
  const [file] = parseUnifiedDiff(DIFF);

  /* When */
  const digits = lineNumberDigits(file);

  /* Then */
  assert.equal(digits, 3, 'line 101 is the furthest a hunk reaches');
});

test('the line-number gutter of an empty file is one digit wide', () => {
  /* When */
  const digits = lineNumberDigits({ hunks: [] });

  /* Then */
  assert.equal(digits, 1);
});

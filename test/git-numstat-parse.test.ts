import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumstat, parseRawDiff } from '../src/domain/git/numstat-parse';

/** NUL-terminated fields, as `-z` frames them. */
const record = (...fields: string[]): string => fields.map(field => `${field}\0`).join('');

// One `git diff --raw --numstat -z` call: the raw section, then the numstat
// section, in one stream. Copied from a real run.
const SUMMARY = record(
  ':100644 100644 58dd9fe 0000000 M', 'lib/b.bin',
  ':100644 000000 b023018 0000000 D', 'gone.txt',
  ':000000 100644 0000000 9d0f44f A', 'new.txt',
  ':100644 100755 4163036 0000000 M', 'run.sh',
  ':100644 100644 470f8c7 4019642 R097', 'from.txt', 'to.txt',
  '-\t-\tlib/b.bin',
  '0\t1\tgone.txt',
  '1\t0\tnew.txt',
  '0\t0\trun.sh',
  '1\t1\t', 'from.txt', 'to.txt',
);

// --- numstat ---

test('a plain record is two counts and a path', () => {
  assert.deepEqual(parseNumstat(record('12\t3\tsrc/app.ts')), [
    { path: 'src/app.ts', additions: 12, deletions: 3, binary: false },
  ]);
});

test('a binary file counts as nothing, because "lines" is not a thing it has', () => {
  assert.deepEqual(parseNumstat(record('-\t-\tassets/logo.png')), [
    { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
  ]);
});

test('a rename spells its path as two extra fields, old first', () => {
  assert.deepEqual(parseNumstat(record('1\t1\t', 'src/old.ts', 'src/new.ts')), [
    { path: 'src/new.ts', oldPath: 'src/old.ts', additions: 1, deletions: 1, binary: false },
  ]);
});

test('the fields after a rename are consumed, not read as records of their own', () => {
  const entries = parseNumstat(record('1\t1\t', 'src/old.ts', 'src/new.ts', '4\t0\tafter.ts'));
  assert.deepEqual(entries.map(entry => entry.path), ['src/new.ts', 'after.ts']);
});

test('nothing changed is an empty list', () => {
  assert.deepEqual(parseNumstat(''), []);
  assert.deepEqual(parseNumstat('\0'), []);
});

test('a path with a space or a tab in it survives, since the counts are what is split on', () => {
  assert.deepEqual(parseNumstat(record('1\t1\tdocs/my notes.md', '2\t0\todd\tname.txt')), [
    { path: 'docs/my notes.md', additions: 1, deletions: 1, binary: false },
    { path: 'odd\tname.txt', additions: 2, deletions: 0, binary: false },
  ]);
});

test('output that was cut off mid-rename stops rather than inventing a path', () => {
  assert.deepEqual(parseNumstat(record('1\t1\t', 'src/old.ts')), []);
});

// --- raw ---

test('the raw section says what happened to each path, and with which modes', () => {
  assert.deepEqual(parseRawDiff(SUMMARY), [
    { path: 'lib/b.bin', status: 'M', oldMode: '100644', newMode: '100644' },
    { path: 'gone.txt', status: 'D', oldMode: '100644', newMode: '000000' },
    { path: 'new.txt', status: 'A', oldMode: '000000', newMode: '100644' },
    { path: 'run.sh', status: 'M', oldMode: '100644', newMode: '100755' },
    { path: 'to.txt', status: 'R', similarity: 97, oldPath: 'from.txt', oldMode: '100644', newMode: '100644' },
  ]);
});

test('a gitlink is recognisable by its mode, which is the only place it says so', () => {
  const submodule = record(':160000 160000 f5031bb 9e6b543 M', 'vendor/sub');
  assert.deepEqual(parseRawDiff(submodule), [
    { path: 'vendor/sub', status: 'M', oldMode: '160000', newMode: '160000' },
  ]);
});

test('a type change and an unpairable file both read as modifications', () => {
  const odd = record(':100644 120000 aaaaaaa bbbbbbb T', 'link', ':100644 100644 ccccccc ddddddd X', 'mystery');
  assert.deepEqual(parseRawDiff(odd).map(entry => entry.status), ['M', 'M']);
});

test('an unmerged path keeps its own letter here too', () => {
  const conflicted = record(':100644 100644 aaaaaaa 0000000 U', 'conflicted.ts');
  assert.deepEqual(parseRawDiff(conflicted).map(entry => entry.status), ['U']);
});

// --- the two together ---

test('each section reads its own records and steps over the other, from one combined call', () => {
  const numstat = parseNumstat(SUMMARY);
  assert.deepEqual(numstat.map(entry => entry.path),
    ['lib/b.bin', 'gone.txt', 'new.txt', 'run.sh', 'to.txt']);
  assert.deepEqual(numstat.find(entry => entry.path === 'to.txt'), {
    path: 'to.txt', oldPath: 'from.txt', additions: 1, deletions: 1, binary: false,
  });
  assert.equal(numstat.find(entry => entry.path === 'lib/b.bin')?.binary, true);
  assert.equal(parseRawDiff(SUMMARY).length, 5, 'the numstat records are not raw records');
});

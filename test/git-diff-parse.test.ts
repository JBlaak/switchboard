import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../src/domain/git/diff-parse';

/**
 * Every fixture here is real `git diff -U3 --find-renames --no-color` output,
 * pasted from a repository built for the purpose — including the details that
 * only a real git produces, like the TAB it appends to a path with a space in
 * it, and the `\ No newline at end of file` that belongs to the line above it.
 */
const patch = (...lines: string[]): string => `${lines.join('\n')}\n`;

test('a multi-hunk file keeps its hunks, its counts and its section headings', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/src/code.js b/src/code.js',
    'index b00b0d2..26217e5 100644',
    '--- a/src/code.js',
    '+++ b/src/code.js',
    '@@ -1,5 +1,5 @@',
    ' one',
    ' two',
    '-three',
    '+THREE',
    ' four',
    ' five',
    '@@ -7,4 +7,4 @@ function foo() {',
    ' seven',
    '-eight',
    '+EIGHT',
    ' nine',
    ' ten',
  ));

  assert.equal(file.path, 'src/code.js');
  assert.equal(file.status, 'M');
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 2);
  assert.equal(file.hunks.length, 2);
  assert.deepEqual(file.hunks[0], {
    header: '@@ -1,5 +1,5 @@',
    oldStart: 1,
    newStart: 1,
    lines: [
      { kind: 'ctx', text: 'one' },
      { kind: 'ctx', text: 'two' },
      { kind: 'del', text: 'three' },
      { kind: 'add', text: 'THREE' },
      { kind: 'ctx', text: 'four' },
      { kind: 'ctx', text: 'five' },
    ],
  });
  assert.equal(file.hunks[1].header, '@@ -7,4 +7,4 @@ function foo() {',
    'the section heading is part of the header the sticky row shows');
  assert.equal(file.hunks[1].oldStart, 7);
});

test('a rename carries both paths and its similarity, and is one file rather than two', () => {
  const files = parseUnifiedDiff(patch(
    'diff --git a/renamed-from.txt b/renamed-to.txt',
    'similarity index 68%',
    'rename from renamed-from.txt',
    'rename to renamed-to.txt',
    'index f1e73fa..bb651f6 100644',
    '--- a/renamed-from.txt',
    '+++ b/renamed-to.txt',
    '@@ -1,4 +1,4 @@',
    ' old contents line 1',
    '-old line 2',
    '+old line 2 changed',
    ' old line 3',
    ' old line 4',
  ));

  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'renamed-to.txt');
  assert.equal(files[0].oldPath, 'renamed-from.txt');
  assert.equal(files[0].status, 'R');
  assert.equal(files[0].similarity, 68);
});

test('a copy is its own status, not a rename that left the original behind', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/base.txt b/copy.txt',
    'similarity index 100%',
    'copy from base.txt',
    'copy to copy.txt',
  ));
  assert.equal(file.status, 'C');
  assert.equal(file.path, 'copy.txt');
  assert.equal(file.oldPath, 'base.txt');
});

test('a binary file says so and has no hunks to show', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/blob.bin b/blob.bin',
    'index b43761b..c332f1a 100644',
    'Binary files a/blob.bin and b/blob.bin differ',
  ));
  assert.equal(file.path, 'blob.bin');
  assert.equal(file.binary, true);
  assert.deepEqual(file.hunks, []);
});

test('a missing final newline is attributed to the side that is missing it', () => {
  const both = parseUnifiedDiff(patch(
    'diff --git a/eof.txt b/eof.txt',
    'index 69db55d..0165cff 100644',
    '--- a/eof.txt',
    '+++ b/eof.txt',
    '@@ -1 +1 @@',
    '-no trailing newline',
    '\\ No newline at end of file',
    '+no trailing newline changed',
    '\\ No newline at end of file',
  ));
  assert.equal(both[0].noNewlineAtEof, 'both');

  const onlyNew = parseUnifiedDiff(patch(
    'diff --git a/eof.txt b/eof.txt',
    'index 69db55d..0165cff 100644',
    '--- a/eof.txt',
    '+++ b/eof.txt',
    '@@ -1 +1 @@',
    '-had one',
    '+lost it',
    '\\ No newline at end of file',
  ));
  assert.equal(onlyNew[0].noNewlineAtEof, 'new');
  assert.deepEqual(onlyNew[0].hunks[0].lines.map(line => line.kind), ['del', 'add'],
    'the marker is a note about the line above, not a line of its own');
});

test('a file whose newline never existed reports both sides, from the context line', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/eof.txt b/eof.txt',
    'index 69db55d..0165cff 100644',
    '--- a/eof.txt',
    '+++ b/eof.txt',
    '@@ -1,2 +1,2 @@',
    '-first',
    '+FIRST',
    ' last line, no newline',
    '\\ No newline at end of file',
  ));
  assert.equal(file.noNewlineAtEof, 'both');
});

test('a chmod is a file with a mode change, no hunks, and a path only the header carries', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/my script.sh b/my script.sh',
    'old mode 100644',
    'new mode 100755',
  ));
  assert.equal(file.path, 'my script.sh', 'the two halves agree, which is what makes the split safe');
  assert.deepEqual(file.modeChange, { from: '100644', to: '100755' });
  assert.deepEqual(file.hunks, []);
  assert.equal(file.additions + file.deletions, 0);
});

test('a submodule pointer is recognised by its mode, and its two lines are the hunk', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/vendor/sub b/vendor/sub',
    'index f5031bb..9e6b543 160000',
    '--- a/vendor/sub',
    '+++ b/vendor/sub',
    '@@ -1 +1 @@',
    '-Subproject commit f5031bbf19c22f624144aaa59da00da2a7611463',
    '+Subproject commit 9e6b54321d102969f4cf52bb74b236e35eadbce3',
  ));
  assert.equal(file.submodule, true);
  assert.equal(file.path, 'vendor/sub');
  assert.deepEqual(file.hunks[0].lines.map(line => line.kind), ['del', 'add']);
});

test('an added file is an addition and a deleted one a deletion, /dev/null and all', () => {
  const added = parseUnifiedDiff(patch(
    'diff --git a/brand new.txt b/brand new.txt',
    'new file mode 100644',
    'index 0000000..92d56ff',
    '--- /dev/null',
    '+++ b/brand new.txt\t',
    '@@ -0,0 +1,2 @@',
    '+new one',
    '+new two',
  ));
  assert.equal(added[0].status, 'A');
  assert.equal(added[0].path, 'brand new.txt', 'the TAB git appends to a spaced path is not part of it');
  assert.equal(added[0].additions, 2);

  const deleted = parseUnifiedDiff(patch(
    'diff --git a/deleted.txt b/deleted.txt',
    'deleted file mode 100644',
    'index 286c5f5..0000000',
    '--- a/deleted.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
  ));
  assert.equal(deleted[0].status, 'D');
  assert.equal(deleted[0].path, 'deleted.txt');
  assert.equal(deleted[0].deletions, 1);
});

test('a quoted path is unquoted, octal escapes and all', () => {
  const [quoted] = parseUnifiedDiff(patch(
    'diff --git "a/quo\\"te.txt" "b/quo\\"te.txt"',
    'index c2b9552..597dad7 100644',
    '--- "a/quo\\"te.txt"',
    '+++ "b/quo\\"te.txt"',
    '@@ -1 +1 @@',
    '-weird',
    '+weird changed',
  ));
  assert.equal(quoted.path, 'quo"te.txt');

  const [unicode] = parseUnifiedDiff(patch(
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'index 4de4f93..a727bb1 100644',
    '--- "a/caf\\303\\251.txt"',
    '+++ "b/caf\\303\\251.txt"',
    '@@ -1 +1 @@',
    '-unicode',
    '+unicode changed',
  ));
  assert.equal(unicode.path, 'café.txt', 'the octal escapes are UTF-8 bytes, decoded together');
});

test('a CR at the end of a line is content, not framing, so a CRLF change is never silent', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/crlf.txt b/crlf.txt',
    'index 1111111..2222222 100644',
    '--- a/crlf.txt',
    '+++ b/crlf.txt',
    '@@ -1 +1 @@',
    '-line one\r',
    '+line one',
  ));
  assert.deepEqual(file.hunks[0].lines, [
    { kind: 'del', text: 'line one\r' },
    { kind: 'add', text: 'line one' },
  ]);
});

test('an empty context line is a single space, and stays a line of the hunk', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/blank.txt b/blank.txt',
    'index 18520d9..28de7a6 100644',
    '--- a/blank.txt',
    '+++ b/blank.txt',
    '@@ -1,4 +1,4 @@',
    ' a',
    ' ',
    '-b',
    '+B',
  ));
  assert.deepEqual(file.hunks[0].lines.map(line => line.text), ['a', '', 'b', 'B']);
});

test('several files in one patch stay several files', () => {
  const files = parseUnifiedDiff(patch(
    'diff --git a/one.txt b/one.txt',
    'index 1111111..2222222 100644',
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/two.txt b/two.txt',
    'index 3333333..4444444 100644',
    '--- a/two.txt',
    '+++ b/two.txt',
    '@@ -1 +1 @@',
    '-c',
    '+d',
  ));
  assert.deepEqual(files.map(file => file.path), ['one.txt', 'two.txt']);
  assert.deepEqual(files.map(file => file.additions), [1, 1]);
});

test('a conflict in the middle of a merge is reported as one, with nothing pretending to be a hunk', () => {
  // What `git diff` prints against the index while a merge is unresolved. The
  // body has a column per parent and this app never renders that: invariant 10
  // says show the file with its markers, not a merge tool.
  const [file] = parseUnifiedDiff(patch(
    'diff --cc c.txt',
    'index db13301,7cab740..0000000',
    '--- a/c.txt',
    '+++ b/c.txt',
    '@@@ -1,3 -1,3 +1,7 @@@',
    '  l1',
    '++<<<<<<< HEAD',
    ' +MAIN',
  ));
  assert.equal(file.path, 'c.txt');
  assert.equal(file.status, 'U');
  assert.deepEqual(file.hunks, []);
});

test('anything before the first file header is ignored', () => {
  const files = parseUnifiedDiff(patch(
    'warning: LF will be replaced by CRLF',
    'diff --git a/one.txt b/one.txt',
    'index 1111111..2222222 100644',
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ));
  assert.deepEqual(files.map(file => file.path), ['one.txt']);
});

test('nothing changed is no files at all', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('the classifications the layer above owns are left alone', () => {
  const [file] = parseUnifiedDiff(patch(
    'diff --git a/package-lock.json b/package-lock.json',
    'index 1111111..2222222 100644',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1 +1 @@',
    '-  "version": "1.0.0",',
    '+  "version": "1.0.1",',
  ));
  assert.equal(file.generated, false, 'the parser reports the patch, not what to think of it');
  assert.equal(file.whitespaceOnly, false);
  assert.equal(file.truncated, undefined);
});

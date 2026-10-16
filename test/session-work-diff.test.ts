import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collapseReason, commentAnchor, parseUnifiedDiff } from '../src/domain/session-work/diff';

const diff = (...lines: string[]) => lines.join('\n') + '\n';

test('a modified file keeps old and new line numbers on every line', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,4 +10,5 @@ function main() {',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' const d = 5;',
    ' return a;',
  ));
  assert.equal(file.path, 'src/app.ts');
  assert.equal(file.status, 'modified');
  assert.equal(file.oldPath, undefined);
  assert.equal(file.binary, false);
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);
  const [hunk] = file.hunks;
  assert.deepEqual(
    { oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, section: hunk.section },
    { oldStart: 10, oldLines: 4, newStart: 10, newLines: 5, section: 'function main() {' },
  );
  assert.deepEqual(hunk.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text]), [
    ['context', 10, 10, 'const a = 1;'],
    ['delete', 11, null, 'const b = 2;'],
    ['add', null, 11, 'const b = 3;'],
    ['add', null, 12, 'const c = 4;'],
    ['context', 12, 13, 'const d = 5;'],
    ['context', 13, 14, 'return a;'],
  ]);
});

test('a comment anchors to the left for a deleted line and the right otherwise', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    '+new',
  ));
  const [keep, removed, added] = file.hunks[0].lines;
  assert.deepEqual(commentAnchor(keep), { line: 1, side: 'RIGHT' });
  assert.deepEqual(commentAnchor(removed), { line: 2, side: 'LEFT' });
  assert.deepEqual(commentAnchor(added), { line: 2, side: 'RIGHT' });
});

test('several files and hunks are read apart', () => {
  const files = parseUnifiedDiff(diff(
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1 +1 @@',
    '-a',
    '+A',
    '@@ -20,2 +20,3 @@',
    ' x',
    '+y',
    ' z',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -5,1 +5,0 @@',
    '-gone',
  ));
  assert.deepEqual(files.map((f) => [f.path, f.additions, f.deletions, f.hunks.length]), [
    ['a.ts', 2, 1, 2],
    ['b.ts', 0, 1, 1],
  ]);
  assert.deepEqual(files[0].hunks[1].lines.map((l) => [l.oldLine, l.newLine]), [[20, 20], [null, 21], [21, 22]]);
});

test('a deleted line that looks like a file header stays a deleted line', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/notes.md b/notes.md',
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -1,2 +1,1 @@',
    '--- a/heading',
    ' body',
  ));
  assert.deepEqual(file.hunks[0].lines.map((l) => [l.kind, l.text]), [['delete', '-- a/heading'], ['context', 'body']]);
});

test('new and deleted files', () => {
  const [added, deleted] = parseUnifiedDiff(diff(
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/old.ts b/old.ts',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/old.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-only',
  ));
  assert.equal(added.status, 'added');
  assert.equal(added.path, 'new.ts');
  assert.deepEqual(added.hunks[0].lines.map((l) => [l.oldLine, l.newLine]), [[null, 1], [null, 2]]);
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.path, 'old.ts');
  assert.deepEqual(deleted.hunks[0].lines.map((l) => [l.oldLine, l.newLine]), [[1, null]]);
});

test('an empty new file has no hunks but is still a file', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/empty.txt b/empty.txt',
    'new file mode 100644',
    'index 0000000..e69de29',
  ));
  assert.deepEqual({ path: file.path, status: file.status, hunks: file.hunks.length }, { path: 'empty.txt', status: 'added', hunks: 0 });
});

test('renames, with and without changes, and copies', () => {
  const [pure, edited, copied] = parseUnifiedDiff(diff(
    'diff --git a/src/old name.ts b/src/new name.ts',
    'similarity index 100%',
    'rename from src/old name.ts',
    'rename to src/new name.ts',
    'diff --git a/lib/a.ts b/lib/b.ts',
    'similarity index 90%',
    'rename from lib/a.ts',
    'rename to lib/b.ts',
    'index 1111111..2222222 100644',
    '--- a/lib/a.ts',
    '+++ b/lib/b.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    'diff --git a/c.ts b/d.ts',
    'similarity index 100%',
    'copy from c.ts',
    'copy to d.ts',
  ));
  assert.deepEqual([pure.status, pure.path, pure.oldPath, pure.hunks.length], ['renamed', 'src/new name.ts', 'src/old name.ts', 0]);
  assert.deepEqual([edited.status, edited.path, edited.oldPath, edited.additions], ['renamed', 'lib/b.ts', 'lib/a.ts', 1]);
  assert.deepEqual([copied.status, copied.path, copied.oldPath], ['copied', 'd.ts', 'c.ts']);
});

test('a path with spaces is read whole from the diff --git line', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/my dir/a b.txt b/my dir/a b.txt',
    'old mode 100644',
    'new mode 100755',
  ));
  assert.deepEqual([file.path, file.status], ['my dir/a b.txt', 'modified']);
});

test('git-quoted paths are unquoted, including UTF-8 octal escapes', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git "a/caf\\303\\251 \\"x\\".txt" "b/caf\\303\\251 \\"x\\".txt"',
    '--- "a/caf\\303\\251 \\"x\\".txt"',
    '+++ "b/caf\\303\\251 \\"x\\".txt"',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ));
  assert.equal(file.path, 'café "x".txt');
});

test('binary files are one row with no hunks', () => {
  const [changed, added, patched] = parseUnifiedDiff(diff(
    'diff --git a/logo.png b/logo.png',
    'index 1111111..2222222 100644',
    'Binary files a/logo.png and b/logo.png differ',
    'diff --git a/new.png b/new.png',
    'new file mode 100644',
    'index 0000000..2222222',
    'Binary files /dev/null and b/new.png differ',
    'diff --git a/font.woff b/font.woff',
    'index 1111111..2222222 100644',
    'GIT binary patch',
    'literal 12',
    'zcmZ?wbhEHbRAx|M',
    '',
    'literal 10',
    'zcmZ?wbhEHbRAx',
    '',
  ));
  assert.deepEqual([changed.path, changed.status, changed.binary, changed.hunks.length], ['logo.png', 'modified', true, 0]);
  assert.deepEqual([added.path, added.status, added.binary], ['new.png', 'added', true]);
  assert.deepEqual([patched.path, patched.binary, patched.additions], ['font.woff', true, 0]);
});

test('"No newline at end of file" marks the line before it', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,2 +1,2 @@',
    ' first',
    '-last',
    '\\ No newline at end of file',
    '+last',
  ));
  const lines = file.hunks[0].lines;
  assert.deepEqual(lines.map((l) => [l.kind, l.noNewlineAtEnd ?? false]), [
    ['context', false], ['delete', true], ['add', false],
  ]);
  assert.equal(file.deletions, 1);
  assert.equal(file.additions, 1);
});

test('a marker after the hunk is complete still applies to its last line', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '\\ No newline at end of file',
  ));
  assert.equal(file.hunks[0].lines[1].noNewlineAtEnd, true);
});

test('an empty context line whose space was stripped is still context', () => {
  const [file] = parseUnifiedDiff(diff(
    'diff --git a/x b/x',
    '--- a/x',
    '+++ b/x',
    '@@ -1,3 +1,3 @@',
    ' a',
    '',
    '-b',
    '+c',
  ));
  assert.deepEqual(file.hunks[0].lines.map((l) => [l.kind, l.oldLine, l.newLine]), [
    ['context', 1, 1], ['context', 2, 2], ['delete', 3, null], ['add', null, 3],
  ]);
});

test('a plain diff -u without diff --git lines is read too', () => {
  const files = parseUnifiedDiff(diff(
    '--- a.txt\t2026-01-01 00:00:00',
    '+++ a.txt\t2026-01-02 00:00:00',
    '@@ -1 +1 @@',
    '-x',
    '+y',
    '--- b.txt',
    '+++ b.txt',
    '@@ -1 +1,2 @@',
    ' x',
    '+y',
  ));
  assert.deepEqual(files.map((f) => [f.path, f.additions, f.deletions]), [['a.txt', 1, 1], ['b.txt', 1, 0]]);
});

test('empty input is no files', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('lock files start collapsed, wherever they are', () => {
  for (const path of ['package-lock.json', 'web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
    'Gemfile.lock', 'composer.lock', 'ios/Podfile.lock', 'go.sum']) {
    assert.equal(collapseReason({ path, additions: 1, deletions: 0 }), 'lockfile', path);
  }
  assert.equal(collapseReason({ path: 'package.json', additions: 1, deletions: 0 }), null);
  assert.equal(collapseReason({ path: 'src/go.sum.ts', additions: 1, deletions: 0 }), null);
});

test('generated files start collapsed: build output, or marked linguist-generated', () => {
  for (const path of ['dist/main.js', 'build/out.css', 'out/index.html', 'packages/ui/dist/index.js']) {
    assert.equal(collapseReason({ path, additions: 1, deletions: 0 }), 'generated', path);
  }
  assert.equal(collapseReason({ path: 'src/distance.ts', additions: 1, deletions: 0 }), null);
  assert.equal(collapseReason({ path: 'src/build.ts', additions: 1, deletions: 0 }), null);
  assert.equal(collapseReason({ path: 'src/schema.gen.ts', additions: 1, deletions: 0 }, new Set(['src/schema.gen.ts'])), 'generated');
});

test('files over 400 changed lines start collapsed', () => {
  assert.equal(collapseReason({ path: 'a.ts', additions: 200, deletions: 200 }), null);
  assert.equal(collapseReason({ path: 'a.ts', additions: 201, deletions: 200 }), 'large');
  // A lock file says why it is collapsed before it says it is big.
  assert.equal(collapseReason({ path: 'yarn.lock', additions: 5000, deletions: 0 }), 'lockfile');
});

test('the parser applies the collapse rules', () => {
  const big = Array.from({ length: 401 }, (_, i) => '+line ' + i);
  const files = parseUnifiedDiff(diff(
    'diff --git a/package-lock.json b/package-lock.json',
    '--- a/package-lock.json',
    '+++ b/package-lock.json',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/src/schema.ts b/src/schema.ts',
    '--- a/src/schema.ts',
    '+++ b/src/schema.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'diff --git a/big.ts b/big.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/big.ts',
    '@@ -0,0 +1,401 @@',
    ...big,
    'diff --git a/small.ts b/small.ts',
    '--- a/small.ts',
    '+++ b/small.ts',
    '@@ -1 +1 @@',
    '-a',
    '+b',
  ), { generatedPaths: ['src/schema.ts'] });
  assert.deepEqual(files.map((f) => [f.path, f.collapsedReason]), [
    ['package-lock.json', 'lockfile'],
    ['src/schema.ts', 'generated'],
    ['big.ts', 'large'],
    ['small.ts', undefined],
  ]);
});

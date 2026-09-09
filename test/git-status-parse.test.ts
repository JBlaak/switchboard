import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, parseStatusBranch } from '../src/domain/git/status-parse';

/**
 * `--porcelain=v2 -z` output is NUL-terminated fields, not lines, so the
 * fixtures are built rather than pasted: `record()` puts the terminator after
 * every field, which is what makes a rename's extra field visible in the test
 * as well as in the parser.
 */
const record = (...fields: string[]): string => fields.map(field => `${field}\0`).join('');

const LISTING = record(
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head main',
  '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa src/app.ts',
  '1 A. N... 000000 100644 100644 0000000 bbbbbbb src/added.ts',
  '1 .D N... 100644 100644 000000 ccccccc ccccccc src/gone.ts',
  // A rename is two fields: the new path, then the original one.
  '2 RM N... 100644 100644 100644 ddddddd ddddddd R087 src/new-name.ts', 'src/old-name.ts',
  'u UU N... 100644 100644 100644 100644 eeeeeee fffffff ggggggg src/conflicted.ts',
  '? notes.md',
  '? scratch/',
  '! build-output.js',
);

test('every kind of record parses, and a rename does not leave a phantom entry behind', () => {
  assert.deepEqual(parseStatus(LISTING), [
    { path: 'src/app.ts', status: 'M' },
    { path: 'src/added.ts', status: 'A' },
    { path: 'src/gone.ts', status: 'D' },
    { path: 'src/new-name.ts', status: 'R', oldPath: 'src/old-name.ts', similarity: 87 },
    { path: 'src/conflicted.ts', status: 'U' },
    { path: 'notes.md', status: '?' },
    { path: 'scratch/', status: '?' },
  ]);
});

test('the original path of a rename is consumed, not read as a record of its own', () => {
  const renamed = record('2 R. N... 100644 100644 100644 aaaaaaa aaaaaaa R100 to.ts', 'from.ts');
  const files = parseStatus(renamed);
  assert.equal(files.length, 1, 'one file moved, not two files changed');
  assert.deepEqual(files[0], { path: 'to.ts', status: 'R', oldPath: 'from.ts', similarity: 100 });
});

test('a conflict stays a conflict all the way out — the surface draws it differently', () => {
  const conflicted = parseStatus(LISTING).filter(file => file.status === 'U');
  assert.deepEqual(conflicted.map(file => file.path), ['src/conflicted.ts']);
});

test('an untracked directory keeps its trailing slash, which is what says "and everything in here"', () => {
  const untracked = parseStatus(LISTING).filter(file => file.status === '?');
  assert.deepEqual(untracked.map(file => file.path), ['notes.md', 'scratch/']);
});

test('an ignored entry is dropped: nothing renders it', () => {
  assert.equal(parseStatus(LISTING).some(file => file.path === 'build-output.js'), false);
});

test('a clean worktree is an empty list, whether git said nothing or only its headers', () => {
  assert.deepEqual(parseStatus(''), []);
  assert.deepEqual(parseStatus(record('# branch.oid 1111111', '# branch.head main')), []);
});

test('a path with a space in it is one path, because only the fields are split', () => {
  const spaced = record('1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa docs/my notes.md');
  assert.deepEqual(parseStatus(spaced), [{ path: 'docs/my notes.md', status: 'M' }]);
});

test('a CR or a newline inside a filename survives, because git did not put it there for us', () => {
  // `-z` exists precisely so this filename cannot break the framing; trimming
  // it here would name a file that does not exist.
  const weird = record(
    '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa crlf\r.txt',
    '? two\nlines.txt',
  );
  assert.deepEqual(parseStatus(weird), [
    { path: 'crlf\r.txt', status: 'M' },
    { path: 'two\nlines.txt', status: '?' },
  ]);
});

test('a malformed record is skipped rather than thrown over — an agent is writing in there', () => {
  const truncated = record('1 .M N... 100644', '1 .M N... 100644 100644 100644 aaaaaaa aaaaaaa fine.ts');
  assert.deepEqual(parseStatus(truncated), [{ path: 'fine.ts', status: 'M' }]);
});

// --- XY, as one letter ---

test('gone from disk wins over whatever the index was holding', () => {
  const staged = record('1 MD N... 100644 100644 000000 aaaaaaa bbbbbbb edited-then-deleted.ts');
  assert.deepEqual(parseStatus(staged), [{ path: 'edited-then-deleted.ts', status: 'D' }]);
});

test('a new file that has been edited since is still new', () => {
  const added = record('1 AM N... 000000 100644 100644 0000000 bbbbbbb new.ts');
  assert.deepEqual(parseStatus(added), [{ path: 'new.ts', status: 'A' }]);
});

test('a type change reads as a modification: the file is there and it is different', () => {
  const typechange = record('1 .T N... 100644 100644 120000 aaaaaaa aaaaaaa now-a-symlink');
  assert.deepEqual(parseStatus(typechange), [{ path: 'now-a-symlink', status: 'M' }]);
});

// --- The branch headers ---

test('the branch headers carry the HEAD sha, which is half the diff cache key', () => {
  assert.deepEqual(parseStatusBranch(LISTING), {
    head: '1111111111111111111111111111111111111111',
    branch: 'main',
    detached: false,
  });
});

test('a detached HEAD is reported as detached, not as a branch named HEAD', () => {
  const detached = record('# branch.oid 2222222222222222222222222222222222222222', '# branch.head (detached)');
  assert.deepEqual(parseStatusBranch(detached), {
    head: '2222222222222222222222222222222222222222',
    branch: null,
    detached: true,
  });
});

test('a repository with no commits yet has no HEAD sha', () => {
  const initial = record('# branch.oid (initial)', '# branch.head main');
  assert.deepEqual(parseStatusBranch(initial), { head: null, branch: 'main', detached: false });
});

test('output without headers answers nothing rather than guessing', () => {
  assert.deepEqual(parseStatusBranch(''), { head: null, branch: null, detached: false });
});

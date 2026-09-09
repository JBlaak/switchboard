import { test } from 'node:test';
import assert from 'node:assert';
import {
  SKELETON_ROWS,
  applyListing, canExpand, collapse, createRoot, expand, filterRows, joinPath,
  nameHighlight, toggle, visibleRows,
} from '../src/renderer/features/files/file-tree-model';
import type { FileNode, FileRow } from '../src/renderer/features/files/file-tree-model';
import type { BrowseEntry } from '../src/domain/browse/types';

/**
 * The file tree's rules, exercised without a DOM.
 *
 * `file-tree-model.ts` is deliberately the only part of the tree with decisions
 * in it — `file-tree.ts` builds elements and calls IPC — and it imports nothing
 * that touches `document`, which is what lets this file import it at all.
 */

const dir = (name: string): BrowseEntry => ({ name, isDirectory: true, isSymbolicLink: false });
const file = (name: string): BrowseEntry => ({ name, isDirectory: false, isSymbolicLink: false });
/** A symlink, as the service reports one: a leaf whatever it points at. */
const link = (name: string): BrowseEntry => ({ name, isDirectory: false, isSymbolicLink: true });

/** The one child of `node` called `name`. Fails the test if there isn't one. */
function child(node: FileNode, name: string): FileNode {
  const found = (node.children ?? []).find(entry => entry.name === name);
  assert.ok(found, `expected a child called ${name}`);
  return found;
}

/** Every row as `depth:name`, or `depth:<kind>` for the rows that are not names. */
function shape(rows: readonly FileRow[]): string[] {
  return rows.map(row => row.kind === 'entry'
    ? `${row.depth}:${row.node.name}`
    : `${row.depth}:<${row.kind}>`);
}

/**
 * The fixture: a root with `src/` (holding `renderer/app.ts`), `docs/`,
 * a `README.md` and a `link.ts` symlink. Only what a test expands is listed.
 */
function fixture(): FileNode {
  const root = createRoot();
  applyListing(root, { entries: [dir('src'), dir('docs'), file('README.md'), link('link.ts')] });
  return root;
}

// ── the shape of a listing ────────────────────────────────────────────────────

test('a listing becomes children in the order it arrived', () => {
  const root = fixture();
  // Not re-sorted: the main process already put directories first and sorted
  // the rest, and a second opinion here could only disagree with it.
  assert.deepStrictEqual((root.children ?? []).map(node => node.name),
    ['src', 'docs', 'README.md', 'link.ts']);
  assert.strictEqual(root.loading, false);
  assert.strictEqual(root.unreadable, false);
});

test('a directory that could not be read says so instead of listing', () => {
  const root = createRoot();
  root.loading = true;
  applyListing(root, { entries: [], unreadable: true });

  assert.strictEqual(root.unreadable, true);
  assert.strictEqual(root.loading, false);
  assert.deepStrictEqual(shape(visibleRows(root)), ['0:<unreadable>']);
});

// ── paths ─────────────────────────────────────────────────────────────────────

test('paths are joined relative to the worktree, root included', () => {
  assert.strictEqual(joinPath('', 'src'), 'src');
  assert.strictEqual(joinPath('src', 'renderer'), 'src/renderer');
  assert.strictEqual(joinPath('src/renderer', 'app.ts'), 'src/renderer/app.ts');
});

test('every node carries its own path, built as the tree was walked', () => {
  const root = fixture();
  assert.strictEqual(root.path, '');
  assert.strictEqual(child(root, 'src').path, 'src');

  const src = child(root, 'src');
  applyListing(src, { entries: [dir('renderer')] });
  const renderer = child(src, 'renderer');
  applyListing(renderer, { entries: [file('app.ts')] });

  assert.strictEqual(renderer.path, 'src/renderer');
  assert.strictEqual(child(renderer, 'app.ts').path, 'src/renderer/app.ts');
});

// ── expanding and collapsing ──────────────────────────────────────────────────

test('expanding inserts the children one level in', () => {
  const root = fixture();
  const src = child(root, 'src');
  expand(src);
  applyListing(src, { entries: [dir('renderer'), file('index.ts')] });

  assert.deepStrictEqual(shape(visibleRows(root)), [
    '0:src', '1:renderer', '1:index.ts', '0:docs', '0:README.md', '0:link.ts',
  ]);
});

test('a collapse drops the rows below but remembers the branch', () => {
  const root = fixture();
  const src = child(root, 'src');
  expand(src);
  applyListing(src, { entries: [dir('renderer')] });
  const renderer = child(src, 'renderer');
  expand(renderer);
  applyListing(renderer, { entries: [file('app.ts')] });

  assert.deepStrictEqual(shape(visibleRows(root)).slice(0, 3), ['0:src', '1:renderer', '2:app.ts']);

  collapse(src);
  assert.deepStrictEqual(shape(visibleRows(root)),
    ['0:src', '0:docs', '0:README.md', '0:link.ts']);

  // Nothing was thrown away: reopening shows the same branch, and asks for no
  // listing it has already paid for.
  expand(src);
  assert.deepStrictEqual(shape(visibleRows(root)).slice(0, 3), ['0:src', '1:renderer', '2:app.ts']);
  assert.notStrictEqual(renderer.children, null);
});

test('toggle flips a directory and reports where it landed', () => {
  const root = fixture();
  const src = child(root, 'src');
  assert.strictEqual(toggle(src), true);
  assert.strictEqual(src.expanded, true);
  assert.strictEqual(toggle(src), false);
  assert.strictEqual(src.expanded, false);
});

test('a symlink is a leaf: it cannot be expanded and never gets a chevron', () => {
  const root = fixture();
  const symlink = child(root, 'link.ts');

  assert.strictEqual(canExpand(symlink), false);
  assert.strictEqual(expand(symlink), false);
  assert.strictEqual(toggle(symlink), false);
  assert.strictEqual(symlink.expanded, false);

  const row = visibleRows(root).find(r => r.kind === 'entry' && r.node === symlink);
  assert.ok(row && row.kind === 'entry');
  assert.strictEqual(row.open, false);
});

test('a plain file cannot be expanded either', () => {
  const root = fixture();
  assert.strictEqual(canExpand(child(root, 'README.md')), false);
  assert.strictEqual(toggle(child(root, 'README.md')), false);
});

// ── the rows on screen ────────────────────────────────────────────────────────

test('rows come out in order, depth-first, with the root at depth 0', () => {
  const root = fixture();
  const src = child(root, 'src');
  const docs = child(root, 'docs');
  expand(src);
  applyListing(src, { entries: [dir('renderer'), file('index.ts')] });
  expand(docs);
  applyListing(docs, { entries: [file('design.md')] });
  const renderer = child(src, 'renderer');
  expand(renderer);
  applyListing(renderer, { entries: [file('app.ts')] });

  assert.deepStrictEqual(shape(visibleRows(root)), [
    '0:src',
    '1:renderer',
    '2:app.ts',
    '1:index.ts',
    '0:docs',
    '1:design.md',
    '0:README.md',
    '0:link.ts',
  ]);
});

test('an open directory says what it is doing when it has no names to show', () => {
  const root = fixture();
  const src = child(root, 'src');
  expand(src);

  // Being read: skeletons, at the depth its children will land on.
  src.loading = true;
  const loading = visibleRows(root);
  assert.deepStrictEqual(shape(loading).slice(0, SKELETON_ROWS + 1),
    ['0:src', ...Array<string>(SKELETON_ROWS).fill('1:<loading>')]);

  // Read, and there was nothing in it.
  applyListing(src, { entries: [] });
  assert.deepStrictEqual(shape(visibleRows(root)).slice(0, 2), ['0:src', '1:<empty>']);

  // Closed: it goes back to being one row, whatever it did or did not hold.
  collapse(src);
  assert.deepStrictEqual(shape(visibleRows(root)), ['0:src', '0:docs', '0:README.md', '0:link.ts']);
});

test('a directory nobody has opened costs no rows', () => {
  const root = fixture();
  assert.deepStrictEqual(shape(visibleRows(root)),
    ['0:src', '0:docs', '0:README.md', '0:link.ts']);
});

// ── the search filter ─────────────────────────────────────────────────────────

/** The fixture, with `src/renderer/app.ts` and `docs/design.md` loaded. */
function loadedTree(): FileNode {
  const root = fixture();
  const src = child(root, 'src');
  applyListing(src, { entries: [dir('renderer'), file('index.ts')] });
  const renderer = child(src, 'renderer');
  applyListing(renderer, { entries: [file('app.ts'), file('app.test.ts')] });
  const docs = child(root, 'docs');
  applyListing(docs, { entries: [file('design.md')] });
  return root;
}

test('an empty query is not a filter', () => {
  const root = loadedTree();
  assert.deepStrictEqual(filterRows(root, ''), visibleRows(root));
  assert.deepStrictEqual(filterRows(root, '   '), visibleRows(root));
});

test('a match keeps the leaf and the folders needed to reach it', () => {
  const root = loadedTree();
  // Nothing is expanded, so none of this is on screen unfiltered.
  assert.deepStrictEqual(shape(visibleRows(root)),
    ['0:src', '0:docs', '0:README.md', '0:link.ts']);

  assert.deepStrictEqual(shape(filterRows(root, 'design')), ['0:docs', '1:design.md']);
  assert.deepStrictEqual(shape(filterRows(root, 'app.')),
    ['0:src', '1:renderer', '2:app.ts', '2:app.test.ts']);
});

test('an ancestor of a hit is drawn open without being marked open', () => {
  const root = loadedTree();

  const [srcRow] = filterRows(root, 'app.ts');
  assert.ok(srcRow.kind === 'entry' && srcRow.node.name === 'src');
  assert.strictEqual(srcRow.open, true);
  // Drawn open, not marked open: the tree the user left is untouched, so
  // clearing the query puts back their branch and not their query's.
  assert.strictEqual(srcRow.node.expanded, false);

  // A hit on a folder's own name is a hit on every path below it, so its loaded
  // contents come with it.
  assert.deepStrictEqual(shape(filterRows(root, 'docs')), ['0:docs', '1:design.md']);
});

test('a folder with nothing loaded under it stays closed when it matches', () => {
  const root = fixture();
  const [row] = filterRows(root, 'src');
  assert.ok(row.kind === 'entry' && row.node.name === 'src');
  assert.strictEqual(row.open, false);
});

test('the query is matched against the path, so a folder name narrows it', () => {
  const root = loadedTree();
  assert.deepStrictEqual(shape(filterRows(root, 'renderer/app.test')),
    ['0:src', '1:renderer', '2:app.test.ts']);
  assert.deepStrictEqual(shape(filterRows(root, 'MD')), ['0:docs', '1:design.md', '0:README.md']);
  assert.deepStrictEqual(filterRows(root, 'nothing-here'), []);
});

test('the tree is restored when the query goes away', () => {
  const root = loadedTree();
  const before = shape(visibleRows(root));
  filterRows(root, 'app.ts');
  filterRows(root, 'design');
  assert.deepStrictEqual(shape(visibleRows(root)), before);
  assert.deepStrictEqual(shape(filterRows(root, '')), before);
});

test('only what has been loaded can match', () => {
  const root = fixture();
  // `src` has never been listed, so the file inside it is not there to find.
  assert.deepStrictEqual(filterRows(root, 'app.ts'), []);
  assert.deepStrictEqual(shape(filterRows(root, 'src')), ['0:src']);
});

// ── which characters the row highlights ───────────────────────────────────────

test('a hit inside the name is highlighted in the name coordinates', () => {
  const root = loadedTree();
  const rows = filterRows(root, 'app');
  const hit = rows.find(row => row.kind === 'entry' && row.node.name === 'app.ts');
  assert.ok(hit && hit.kind === 'entry');
  // 'app' sits at 13..16 of 'src/renderer/app.ts', which is 0..3 of 'app.ts'.
  assert.deepStrictEqual(hit.match, { start: 13, end: 16 });
  assert.deepStrictEqual(nameHighlight(hit.node, hit.match), { start: 0, end: 3 });
});

test('a hit that only covers ancestors highlights nothing on the child row', () => {
  const root = loadedTree();
  const rows = filterRows(root, 'src/');
  const renderer = rows.find(row => row.kind === 'entry' && row.node.name === 'renderer');
  assert.ok(renderer && renderer.kind === 'entry');
  // 'src/' matched at 0..4 of 'src/renderer', all of it above the name.
  assert.strictEqual(nameHighlight(renderer.node, renderer.match), null);
});

test('a hit straddling the separator is clipped to the part inside the name', () => {
  const root = loadedTree();
  const rows = filterRows(root, 'src/ind');
  const index = rows.find(row => row.kind === 'entry' && row.node.name === 'index.ts');
  assert.ok(index && index.kind === 'entry');
  assert.deepStrictEqual(nameHighlight(index.node, index.match), { start: 0, end: 3 });
});

test('no match is no highlight', () => {
  const root = fixture();
  assert.strictEqual(nameHighlight(child(root, 'src'), undefined), null);
});

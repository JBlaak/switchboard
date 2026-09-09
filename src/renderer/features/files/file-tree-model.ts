/**
 * The file tree's rules, with no DOM in them.
 *
 * What the tree is made of, how expanding and collapsing move it, which rows
 * are on screen and at what depth, and what a search query leaves standing.
 * All of it decided here so it can be tested by calling a function — the tree
 * itself is element building and IPC, and there is no jsdom in this repo to put
 * that under test. `file-tree.ts` draws and fetches and decides nothing else
 * worth asserting on.
 *
 * Kept free of `../../lib/dom` on purpose: that module resolves every element
 * handle at import, so anything that reaches it cannot be imported by a test.
 *
 * The tree is a plain mutable structure rather than a store with methods. It is
 * built from what one directory listing said and thrown away whole when the
 * scope changes, so there is no state here worth defending behind an interface.
 */
import type { BrowseEntry, BrowseListing } from '../../../domain/browse/types';

/**
 * One name in the tree — and the root, whose `path` is `''`.
 *
 * `children` is the listing for a directory, and doubles as the cache: `null`
 * means "never fetched", `[]` means "fetched, and there was nothing in it".
 * Each fetch is an IPC round trip and a `git check-ignore` process in the main
 * process, so a directory is read once and the answer stays on the node —
 * collapsing and reopening a folder costs nothing.
 */
export interface FileNode {
  /** The name as the directory listed it. Empty for the root. */
  name: string;
  /** Forward-slashed and relative to the worktree; `''` is the root. */
  path: string;
  /** True only for a real directory. A symlink is a leaf, whatever it points at. */
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /** The listing for this directory, or null until it has been fetched. */
  children: FileNode[] | null;
  /** Whether this directory's children are on screen. */
  expanded: boolean;
  /** A fetch is in flight: the rows below this node are skeletons. */
  loading: boolean;
  /** The listing came back `unreadable` — gone, or not ours to read. */
  unreadable: boolean;
}

/** Half-open `[start, end)` into a string, for painting a search hit. */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * One line of the tree as drawn, top to bottom.
 *
 * The pseudo-rows are here rather than in the drawing because they have to land
 * in the right place — a folder's skeletons belong between it and its next
 * sibling — and only the flattening knows where that is.
 */
export type FileRow =
  /** A name in the tree. `open` is whether its chevron points down. */
  | { kind: 'entry'; depth: number; node: FileNode; open: boolean; match?: MatchRange }
  /** A directory whose listing is in flight. One row per skeleton bar. */
  | { kind: 'loading'; depth: number; path: string }
  /** A directory that was read and had nothing in it. */
  | { kind: 'empty'; depth: number; path: string }
  /** A directory the main process could not read. */
  | { kind: 'unreadable'; depth: number; path: string };

/**
 * How many skeleton bars stand in for a directory being read.
 *
 * Enough to read as "a list is coming" rather than as one stuck row, few enough
 * that a directory with two entries in it does not visibly shrink on arrival.
 */
export const SKELETON_ROWS = 3;

/** The worktree itself: expanded from the start, and never drawn as a row. */
export function createRoot(): FileNode {
  return {
    name: '',
    path: '',
    isDirectory: true,
    isSymbolicLink: false,
    children: null,
    expanded: true,
    loading: false,
    unreadable: false,
  };
}

/**
 * A child's path, relative to the worktree.
 *
 * Always forward-slashed, because that is what `listDir` takes on every
 * platform — the main process is the one that knows how the host spells a path,
 * and the renderer has no `path` module to ask.
 */
export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/**
 * Hang a listing under `node`, as its one and only fetch.
 *
 * The entries are used in the order they arrive and none are dropped: the main
 * process has already put directories first, sorted the rest case-insensitively
 * and removed what git ignores, and a second opinion here would only be able to
 * disagree with it.
 *
 * A previous listing is replaced outright, so everything below `node` — which
 * folders were open down there — is forgotten. That only happens when something
 * asks for the same directory twice, which nothing does today.
 */
export function applyListing(node: FileNode, listing: BrowseListing): void {
  node.loading = false;
  node.unreadable = listing.unreadable === true;
  node.children = listing.entries.map(entry => childOf(node, entry));
}

function childOf(parent: FileNode, entry: BrowseEntry): FileNode {
  return {
    name: entry.name,
    path: joinPath(parent.path, entry.name),
    isDirectory: entry.isDirectory,
    isSymbolicLink: entry.isSymbolicLink,
    children: null,
    expanded: false,
    loading: false,
    unreadable: false,
  };
}

/** Whether this node has anything to open. A symlink never does. */
export function canExpand(node: FileNode): boolean {
  return node.isDirectory;
}

/** Open a directory. False for a leaf, which has nothing to show. */
export function expand(node: FileNode): boolean {
  if (!canExpand(node)) return false;
  node.expanded = true;
  return true;
}

/**
 * Close a directory, keeping everything below it.
 *
 * The listing and the expansion state of every folder inside it stay on the
 * node, so reopening this one shows the same branch the user left rather than a
 * collapsed level and another round of fetches.
 */
export function collapse(node: FileNode): void {
  node.expanded = false;
}

/** Flip a directory open or closed. Returns whether it is now open. */
export function toggle(node: FileNode): boolean {
  if (!canExpand(node)) return false;
  if (node.expanded) {
    collapse(node);
    return false;
  }
  return expand(node);
}

/** The rows on screen, in order, with the root's own children at depth 0. */
export function visibleRows(root: FileNode): FileRow[] {
  const rows: FileRow[] = [];
  pushLevel(root, 0, rows);
  return rows;
}

/**
 * One expanded directory's rows, and recursively those of its open children.
 *
 * A level that cannot be drawn as names says so in one pseudo-row instead:
 * unreadable outranks loading, which outranks empty, because each is a stronger
 * statement about the same directory.
 */
function pushLevel(node: FileNode, depth: number, rows: FileRow[]): void {
  if (node.unreadable) {
    rows.push({ kind: 'unreadable', depth, path: node.path });
    return;
  }
  if (node.children === null) {
    if (node.loading) {
      for (let i = 0; i < SKELETON_ROWS; i++) rows.push({ kind: 'loading', depth, path: node.path });
    }
    return;
  }
  if (node.children.length === 0) {
    rows.push({ kind: 'empty', depth, path: node.path });
    return;
  }
  for (const child of node.children) {
    const open = canExpand(child) && child.expanded;
    rows.push({ kind: 'entry', depth, node: child, open });
    if (open) pushLevel(child, depth + 1, rows);
  }
}

/**
 * The rows a query leaves standing: every loaded path that contains it, plus
 * the folders above them so each one can be reached.
 *
 * Filtered locally and off the tree already in hand — no IPC. A search that
 * asked the main process would be a recursive walk of the whole worktree per
 * keystroke, which is exactly what the one-level-at-a-time listing exists to
 * avoid. The cost is that the filter only sees what has been opened, which is
 * why opening a folder while a query is up widens it rather than doing nothing.
 *
 * Nothing here mutates the tree — the ancestors of a hit are drawn open without
 * being marked open — so clearing the query puts back the branch the user had,
 * not the one their query implied.
 */
export function filterRows(root: FileNode, query: string): FileRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return visibleRows(root);

  const rows: FileRow[] = [];
  for (const child of root.children ?? []) rows.push(...matchingSubtree(child, 0, needle));
  return rows;
}

function matchingSubtree(node: FileNode, depth: number, needle: string): FileRow[] {
  const below: FileRow[] = [];
  for (const child of node.children ?? []) below.push(...matchingSubtree(child, depth + 1, needle));

  const match = matchIn(node.path, needle);
  if (below.length === 0 && match === null) return [];

  // A folder is drawn open exactly when the filter is showing something inside
  // it; one that matched on its own name stays as the user left it, so a hit on
  // a directory does not silently unfold everything below it.
  const open = below.length > 0 || (canExpand(node) && node.expanded);
  const row: FileRow = match === null
    ? { kind: 'entry', depth, node, open }
    : { kind: 'entry', depth, node, open, match };
  return [row, ...below];
}

/** Where `needle` sits in `text`, case-insensitively, or null. */
function matchIn(text: string, needle: string): MatchRange | null {
  const at = text.toLowerCase().indexOf(needle);
  return at === -1 ? null : { start: at, end: at + needle.length };
}

/**
 * The part of a match that falls inside the node's own name.
 *
 * The query is matched against the whole relative path, so `renderer/app` finds
 * `src/renderer/app.ts` — but the row only prints the last segment, so the
 * highlight has to be moved into that segment's coordinates and clipped to it.
 * A match entirely above the name (the `src/` of `src/renderer`) highlights
 * nothing: the row that owns those characters is already on screen above.
 */
export function nameHighlight(node: FileNode, match: MatchRange | undefined): MatchRange | null {
  if (!match) return null;
  const nameAt = node.path.length - node.name.length;
  const start = Math.max(match.start, nameAt) - nameAt;
  const end = Math.min(match.end, node.path.length) - nameAt;
  return end > start ? { start, end } : null;
}

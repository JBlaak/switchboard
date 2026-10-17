/**
 * The Session work page: which session's page is open, the snapshot it shows,
 * which item is selected, and which sessions the page can open for at all.
 *
 * The page is transient (D4). It belongs to the session on screen, so anything
 * that puts another session on screen, clears the screen, or opens the
 * settings panel in its place closes it — and so does showing its own session
 * again, which is what a click on that session's row does. Nothing about a
 * closed page is kept: opening it again starts from a skeleton.
 *
 * `canOpen` is the one thing kept across pages: every row asks once whether
 * its meta line is a button, and the answer is not going to change while the
 * app runs — except for a session main did not know yet when it was asked (a
 * new one, before its process started), which is why a "no" is dropped when
 * that session comes on screen.
 */
import { movedEntry, withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';
import type { FileDiff, SessionWorkDiff, SessionWorkSnapshot } from '../../domain/session-work/model';

export interface SessionWorkPage {
  readonly sessionId: string;
  /** The header's `Work · <name>`, as of when the page opened (or the session was renamed). */
  readonly name: string;
  /** null until the first snapshot: the list shows a skeleton. */
  readonly snapshot: SessionWorkSnapshot | null;
  /** The item the detail shows (`SessionWorkItem.id`); null when nothing is selectable. */
  readonly selectedItemId: string | null;
  /** Whether the Done group is expanded. Collapsed each time the page opens. */
  readonly doneExpanded: boolean;
  /** How diffs are drawn. Unified each time the page opens (D7). */
  readonly diffMode: DiffMode;
  /**
   * itemId → its diff, loaded lazily when the item is selected and kept while
   * the page is open, so going back to an item does not ask main again.
   */
  readonly diffs: IdRecord<ItemDiff>;
}

export type DiffMode = 'unified' | 'split';

/** One item's diff on the page, and what the reader did to it. */
export interface ItemDiff {
  /** The item it was asked for, as `diffKey` put it: an item that changed asks again. */
  readonly key: string;
  readonly phase: 'loading' | 'loaded' | 'failed';
  /** Kept while it loads again, so a refresh does not blank the page. */
  readonly files: readonly FileDiff[];
  /** Where the files came from: `github` when the branch is not checked out here (D8). */
  readonly source: SessionWorkDiff['source'];
  /** Why there is no diff; null unless `failed`. */
  readonly error: string | null;
  /** Paths of files that started collapsed and were opened with "Show diff". */
  readonly expanded: readonly string[];
  /** The file `n`/`p` last moved to; null before either was pressed. */
  readonly focusedPath: string | null;
}

export interface SessionWorkState {
  readonly page: SessionWorkPage | null;
  /** sessionId → whether the page can open for it, once main has been asked. */
  readonly canOpen: IdRecord<boolean>;
  /** The page's clock, for "updated Xs ago": stamped when it opens and on each tick. */
  readonly now: number;
}

export const initialSessionWorkState: SessionWorkState = { page: null, canOpen: {}, now: 0 };

export function sessionWorkReducer(state: SessionWorkState, event: RendererEvent): SessionWorkState {
  switch (event.type) {
    case 'sessionWorkOpened': {
      if (state.page?.sessionId === event.sessionId) return state;
      return {
        ...state,
        now: event.at,
        page: {
          sessionId: event.sessionId, name: event.name, snapshot: null, selectedItemId: null, doneExpanded: false,
          diffMode: 'unified', diffs: {},
        },
      };
    }

    case 'sessionWorkClosed':
      return state.page?.sessionId === event.sessionId ? { ...state, page: null } : state;

    case 'sessionWorkSnapshot': {
      const { page } = state;
      if (!page || page.sessionId !== event.snapshot.sessionId) return state;
      const selectedItemId = keptSelection(event.snapshot, page.selectedItemId);
      const diffs = keptDiffs(page.diffs, event.snapshot);
      return { ...state, page: { ...page, snapshot: event.snapshot, selectedItemId, diffs } };
    }

    case 'sessionWorkDiffRequested': {
      const { page } = state;
      if (!page || page.sessionId !== event.sessionId) return state;
      const before = page.diffs[event.itemId];
      if (before?.key === event.key && before.phase === 'loading') return state;
      const diff: ItemDiff = before
        ? { ...before, key: event.key, phase: 'loading', error: null }
        : { key: event.key, phase: 'loading', files: [], source: null, error: null, expanded: [], focusedPath: null };
      return withDiff(state, page, event.itemId, diff);
    }

    case 'sessionWorkDiffLoaded':
    case 'sessionWorkDiffFailed': {
      const { page } = state;
      if (!page || page.sessionId !== event.sessionId) return state;
      const before = page.diffs[event.itemId];
      // An answer for an item that has changed since, or was never asked for, is stale.
      if (!before || before.key !== event.key) return state;
      const error = event.type === 'sessionWorkDiffFailed' ? event.message : event.diff.error ?? null;
      const files = event.type === 'sessionWorkDiffLoaded' ? event.diff.files : [];
      const failed = error !== null && files.length === 0;
      const diff: ItemDiff = {
        ...before,
        phase: failed ? 'failed' : 'loaded',
        files,
        source: event.type === 'sessionWorkDiffLoaded' ? event.diff.source : null,
        error: failed ? error : null,
        focusedPath: before.focusedPath && files.some(file => file.path === before.focusedPath) ? before.focusedPath : null,
      };
      return withDiff(state, page, event.itemId, diff);
    }

    case 'sessionWorkDiffModeSet':
      return state.page && state.page.diffMode !== event.mode
        ? { ...state, page: { ...state.page, diffMode: event.mode } }
        : state;

    case 'sessionWorkFileExpanded': {
      const { page } = state;
      const diff = page?.diffs[event.itemId];
      if (!page || !diff || diff.expanded.includes(event.path)) return state;
      return withDiff(state, page, event.itemId, { ...diff, expanded: [...diff.expanded, event.path] });
    }

    case 'sessionWorkFileFocused': {
      const { page } = state;
      const diff = page?.diffs[event.itemId];
      if (!page || !diff || diff.focusedPath === event.path) return state;
      if (!diff.files.some(file => file.path === event.path)) return state;
      return withDiff(state, page, event.itemId, { ...diff, focusedPath: event.path });
    }

    case 'sessionWorkItemSelected': {
      const { page } = state;
      if (!page?.snapshot || page.selectedItemId === event.itemId) return state;
      if (!selectableItems(page.snapshot).some(item => item.id === event.itemId)) return state;
      return { ...state, page: { ...page, selectedItemId: event.itemId } };
    }

    case 'sessionWorkDoneToggled':
      return state.page ? { ...state, page: { ...state.page, doneExpanded: !state.page.doneExpanded } } : state;

    case 'sessionWorkTicked':
      return state.page && state.now !== event.at ? { ...state, now: event.at } : state;

    case 'sessionWorkEligibility': {
      const canOpen = withEntry(state.canOpen, event.sessionId, event.canOpen);
      return canOpen === state.canOpen ? state : { ...state, canOpen };
    }

    // Another session on screen, or none: the page was this one's.
    case 'activeSessionChanged':
      return state.page && state.page.sessionId !== event.sessionId ? { ...state, page: null } : state;

    // A session put on screen — another one, or this one again from its row —
    // takes the terminal area back. A "no" for it may have been asked before
    // main knew the session; it is asked again.
    case 'sessionShown': {
      const canOpen = state.canOpen[event.sessionId] === false
        ? withoutEntry(state.canOpen, event.sessionId)
        : state.canOpen;
      if (!state.page && canOpen === state.canOpen) return state;
      return { ...state, page: null, canOpen };
    }

    // The settings panel takes the main area in the page's place.
    case 'settingsOpened':
      return state.page ? { ...state, page: null } : state;

    case 'headerRenamed':
      return state.page?.sessionId === event.sessionId && state.page.name !== event.name
        ? { ...state, page: { ...state.page, name: event.name } }
        : state;

    default:
      return state;
  }
}

/** A re-keyed session keeps its open page and what is known about it. */
export function rekeySessionWork(state: SessionWorkState, oldId: string, newId: string): SessionWorkState {
  if (oldId === newId) return state;
  const canOpen = movedEntry(state.canOpen, oldId, newId);
  const page = state.page?.sessionId === oldId ? { ...state.page, sessionId: newId } : state.page;
  return canOpen === state.canOpen && page === state.page ? state : { ...state, canOpen, page };
}

// ── What the page shows, derived from a snapshot ──

type Item = SessionWorkSnapshot['items'][number];

/** The list's three groups (D5, D10), each in the order the snapshot gave. */
export interface WorkSections {
  /** Open and draft PRs, branches without a PR, uncommitted changes. */
  readonly inProgress: readonly Item[];
  /** Issues nothing closes that are still open (or whose state `gh` could not say). */
  readonly issues: readonly Item[];
  /** Merged and closed PRs, then closed issues. */
  readonly done: readonly Item[];
}

/** A merged or closed PR, or a closed issue: finished, whoever finished it. */
export function isDoneItem(item: Item): boolean {
  if (item.kind === 'pr') return item.pr.state === 'merged' || item.pr.state === 'closed';
  if (item.kind === 'issue') return 'state' in item.issue && item.issue.state === 'closed';
  return false;
}

export function workSections(snapshot: SessionWorkSnapshot): WorkSections {
  const inProgress: Item[] = [];
  const issues: Item[] = [];
  const done: Item[] = [];
  const doneIssues: Item[] = [];
  for (const item of snapshot.items) {
    if (isDoneItem(item)) (item.kind === 'issue' ? doneIssues : done).push(item);
    else if (item.kind === 'issue') issues.push(item);
    else inProgress.push(item);
  }
  return { inProgress, issues, done: [...done, ...doneIssues] };
}

/**
 * The items that can be selected, in list order. Issues — open or done — are
 * links out rather than selectable, and Done only counts while it is expanded.
 */
export function selectableItems(snapshot: SessionWorkSnapshot, doneExpanded = true): Item[] {
  const { inProgress, done } = workSections(snapshot);
  return doneExpanded ? [...inProgress, ...done.filter(item => item.kind !== 'issue')] : [...inProgress];
}

/**
 * The selection a new snapshot leaves: the same item while it is still there,
 * otherwise the first one in progress (or the first done one when nothing is).
 */
function keptSelection(snapshot: SessionWorkSnapshot, current: string | null): string | null {
  const items = selectableItems(snapshot);
  if (current && items.some(item => item.id === current)) return current;
  return items[0]?.id ?? null;
}

/**
 * The item `j` (1) or `k` (-1) moves to from `current`, among the ones on
 * screen; null when there is nowhere to go. Stops at either end rather than
 * wrapping, like the list's own cursor.
 */
export function steppedItemId(page: SessionWorkPage, direction: 1 | -1): string | null {
  if (!page.snapshot) return null;
  const ids = selectableItems(page.snapshot, page.doneExpanded).map(item => item.id);
  if (!ids.length) return null;
  const at = page.selectedItemId ? ids.indexOf(page.selectedItemId) : -1;
  if (at === -1) return ids[0];
  const next = at + direction;
  return next >= 0 && next < ids.length ? ids[next] : null;
}

/** The selected item, or null. */
export function selectedItem(page: SessionWorkPage): Item | null {
  if (!page.snapshot || !page.selectedItemId) return null;
  return page.snapshot.items.find(item => item.id === page.selectedItemId) ?? null;
}

// ── Diffs ──

function withDiff(state: SessionWorkState, page: SessionWorkPage, itemId: string, diff: ItemDiff): SessionWorkState {
  return { ...state, page: { ...page, diffs: withEntry(page.diffs, itemId, diff) } };
}

/** The diffs a new snapshot leaves: those of items still in it. A changed item keeps its diff until asked again. */
function keptDiffs(diffs: IdRecord<ItemDiff>, snapshot: SessionWorkSnapshot): IdRecord<ItemDiff> {
  const ids = new Set(snapshot.items.map(item => item.id));
  let kept = diffs;
  for (const id of Object.keys(diffs)) {
    if (!ids.has(id)) kept = withoutEntry(kept, id);
  }
  return kept;
}

/**
 * What an item's diff depends on, as far as the snapshot can tell: its source
 * and the commits or files behind it. An item whose key changes between
 * snapshots has a new diff to fetch; '' for an item with no diff (an issue).
 */
export function diffKey(item: Item): string {
  switch (item.kind) {
    case 'pr':
      return JSON.stringify(['pr', item.diff, item.pr.headSha ?? null, item.pr.additions ?? null, item.pr.deletions ?? null]);
    case 'branch':
      return JSON.stringify(['branch', item.diff, item.ahead, item.additions, item.deletions]);
    case 'dirty':
      return JSON.stringify(['dirty', item.files, item.additions, item.deletions]);
    case 'issue':
      return '';
  }
}

/**
 * The diff the page should ask main for now: the selected item's, when it has
 * none yet or the item changed since it was asked for. Null when there is
 * nothing to ask (no selection, an issue, or it is already on its way).
 */
export function diffToLoad(page: SessionWorkPage): { itemId: string; key: string } | null {
  const item = selectedItem(page);
  if (!item) return null;
  const key = diffKey(item);
  if (!key) return null;
  const known = page.diffs[item.id];
  return known?.key === key ? null : { itemId: item.id, key };
}

/** The selected item's diff, or null before it was asked for. */
export function selectedDiff(page: SessionWorkPage): ItemDiff | null {
  return page.selectedItemId ? page.diffs[page.selectedItemId] ?? null : null;
}

/**
 * The file `n` (1) or `p` (-1) moves to in a diff: the first one when none has
 * been moved to yet; null at either end, or when there are no files.
 */
export function steppedFilePath(diff: ItemDiff, direction: 1 | -1): string | null {
  const paths = diff.files.map(file => file.path);
  if (!paths.length) return null;
  const at = diff.focusedPath ? paths.indexOf(diff.focusedPath) : -1;
  if (at === -1) return paths[0];
  const next = at + direction;
  return next >= 0 && next < paths.length ? paths[next] : null;
}

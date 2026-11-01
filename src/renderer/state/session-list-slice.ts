/**
 * The session list's own state: what the last layout put where, and
 * everything the user did to the list that a redraw must not undo.
 *
 * The layout is computed here, at the moment a redraw is asked for, rather
 * than in the component on every render. Two reasons. Anchoring needs the
 * order the list was *last laid out in* — a fact about the previous redraw,
 * which a render-time ref would have to update from an effect and which
 * StrictMode's double renders would read twice — and as state it is simply
 * the previous value of this slice. And the order must hold still between
 * redraws: a row flagged for attention is marked in place and only changes
 * section on the next redraw, exactly as the vanilla list did, so its classes
 * are read live while its slot is read from here.
 *
 * Element ids, not session ids, key the per-row marks (cursor, rename,
 * leaving), so they follow a re-key without being moved.
 *
 * The events are declared here rather than in `events.ts`, like the toolbar's,
 * so the list's vocabulary stays in one file.
 */
import { layoutRows, layoutSessionList } from './session-list-layout';
import { withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { ListItem, OrderedEntry, SessionListEntry, SessionListLayout } from './session-list-layout';
import type { RendererEvent } from './events';

export type SessionListEvent =
  /** A redraw was asked for: the entries as they stand, to be laid out against the last order. */
  | {
    type: 'sessionListBuilt';
    items: readonly ListItem[];
    activeItemId: string | null;
    /** Let the open session move to its true position too. */
    resort: boolean;
    filtering: boolean;
    visibleSessionCount: number;
    sessionMaxAgeDays: number;
    now: number;
  }
  /** The 30-second tick that keeps the relative times honest. */
  | { type: 'sessionListTicked'; now: number }
  /** A rename went through; the row shows it without waiting for a redraw. */
  | { type: 'sessionRenamed'; sessionId: string; name: string | null }
  | { type: 'slugGroupToggled'; id: string }
  | { type: 'slugGroupExpanded'; id: string }
  /** The groups that were open before a reload. */
  | { type: 'slugGroupsRestored'; ids: readonly string[] }
  | { type: 'olderToggled' }
  | { type: 'renameStarted'; rowId: string }
  | { type: 'renameEnded'; rowId: string }
  /** The keyboard cursor moved (null: it is gone). See `ui/session-list/cursor`. */
  | { type: 'listCursorMoved'; target: string | null }
  /** A row or group started (or stopped) sliding out. */
  | { type: 'rowLeaving'; id: string; leaving: boolean };

export interface SessionListState {
  /** Null until the first redraw. */
  readonly layout: SessionListLayout | null;
  /** The full order of `layout`, folded rows included: what the next layout anchors against. */
  readonly order: readonly OrderedEntry[];
  /** Counts the redraws; a rename patches `layout` without being one. */
  readonly revision: number;
  /** Epoch ms the relative times are measured from. */
  readonly now: number;
  /** Slug group ids that are open. Persisted for the session (see `ui/session-list/actions`). */
  readonly expandedSlugs: IdRecord<true>;
  /** The "+ N older" list is showing. */
  readonly olderExpanded: boolean;
  /** The row with its rename input open. */
  readonly renaming: string | null;
  /** What the keyboard cursor is on: an element id, or `header:<group id>`. */
  readonly cursor: string | null;
  /** Rows and groups mid-exit, by element id. */
  readonly leaving: IdRecord<true>;
}

export const initialSessionListState: SessionListState = {
  layout: null,
  order: [],
  revision: 0,
  now: 0,
  expandedSlugs: {},
  olderExpanded: false,
  renaming: null,
  cursor: null,
  leaving: {},
};

export function sessionListReducer(state: SessionListState, event: RendererEvent): SessionListState {
  switch (event.type) {
    case 'sessionListBuilt':
      return built(state, event);

    case 'sessionListTicked':
      return state.now === event.now ? state : { ...state, now: event.now };

    case 'sessionRenamed':
      return renamed(state, event.sessionId, event.name);

    case 'slugGroupToggled':
      return {
        ...state,
        expandedSlugs: state.expandedSlugs[event.id]
          ? withoutEntry(state.expandedSlugs, event.id)
          : withEntry(state.expandedSlugs, event.id, true),
      };

    case 'slugGroupExpanded':
      return patch(state, { expandedSlugs: withEntry(state.expandedSlugs, event.id, true) });

    case 'slugGroupsRestored': {
      let expandedSlugs = state.expandedSlugs;
      for (const id of event.ids) expandedSlugs = withEntry(expandedSlugs, id, true);
      return patch(state, { expandedSlugs });
    }

    case 'olderToggled':
      return { ...state, olderExpanded: !state.olderExpanded };

    case 'renameStarted':
      return patch(state, { renaming: event.rowId });

    case 'renameEnded':
      return state.renaming === event.rowId ? { ...state, renaming: null } : state;

    case 'listCursorMoved':
      return patch(state, { cursor: event.target });

    case 'rowLeaving':
      return patch(state, {
        leaving: event.leaving
          ? withEntry(state.leaving, event.id, true)
          : withoutEntry(state.leaving, event.id),
      });

    default:
      return state;
  }
}

function built(state: SessionListState, event: Extract<SessionListEvent, { type: 'sessionListBuilt' }>): SessionListState {
  const { layout, order } = layoutSessionList(event.items, state.order, {
    activeItemId: event.activeItemId,
    resort: event.resort,
    filtering: event.filtering,
    visibleSessionCount: event.visibleSessionCount,
    sessionMaxAgeDays: event.sessionMaxAgeDays,
    now: event.now,
  });

  // The group holding the session on screen opens: its terminal is visible,
  // so leaving its row folded away makes the sidebar disagree with the main area.
  const activeGroup = event.items.find(item => item.entry.id === event.activeItemId && item.entry.kind === 'group');
  const expandedSlugs = activeGroup
    ? withEntry(state.expandedSlugs, activeGroup.entry.id, true)
    : state.expandedSlugs;

  return {
    ...state,
    layout,
    order,
    revision: state.revision + 1,
    now: event.now,
    expandedSlugs,
    // A fresh "older" list starts folded, as one that was never opened.
    olderExpanded: layout.older.length > 0 && state.olderExpanded,
    leaving: stillListed(state.leaving, layout),
  };
}

/**
 * Forget the exits of entries no longer listed.
 *
 * A row that finished leaving is gone from the next layout; if the same row
 * comes back later (unarchived, or under the archive filter) it has the same
 * element id and must not arrive already leaving.
 */
function stillListed(leaving: IdRecord<true>, layout: SessionListLayout): IdRecord<true> {
  const ids = Object.keys(leaving);
  if (ids.length === 0) return leaving;
  const listed = new Set<string>([
    ...[...layout.visible, ...layout.older].map(({ entry }) => entry.id),
    ...layoutRows(layout).map(row => row.id),
  ]);
  let next = leaving;
  for (const id of ids) if (!listed.has(id)) next = withoutEntry(next, id);
  return next;
}

/** The new name on every copy of the session the layout holds. */
function renamed(state: SessionListState, sessionId: string, name: string | null): SessionListState {
  const { layout } = state;
  if (!layout) return state;
  let changed = false;
  const rename = <T extends { entry: SessionListEntry }>(laid: T): T => {
    const { entry } = laid;
    if (entry.kind === 'row') {
      if (entry.session.sessionId !== sessionId || entry.session.name === name) return laid;
      changed = true;
      return { ...laid, entry: { ...entry, session: { ...entry.session, name } } };
    }
    if (entry.kind === 'plan') return laid;
    if (!entry.sessions.some(row => row.session.sessionId === sessionId)) return laid;
    changed = true;
    return {
      ...laid,
      entry: {
        ...entry,
        sessions: entry.sessions.map(row => row.session.sessionId === sessionId
          ? { ...row, session: { ...row.session, name } }
          : row),
      },
    };
  };
  const visible = layout.visible.map(rename);
  const older = layout.older.map(rename);
  return changed ? { ...state, layout: { ...layout, visible, older } } : state;
}

/** `state` itself when none of the fields actually changed. */
function patch(state: SessionListState, fields: Partial<SessionListState>): SessionListState {
  for (const key of Object.keys(fields) as (keyof SessionListState)[]) {
    if (!Object.is(fields[key], state[key])) return { ...state, ...fields };
  }
  return state;
}

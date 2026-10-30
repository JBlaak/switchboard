/**
 * The Undo toast an archive brings: "Archived “<name>” · Undo".
 *
 * Only an archive you did here offers it — a row, a slug group, a whole
 * project. One archived from a phone, or by the session itself through its
 * `archive_session` tool, does not: there is nothing of yours to take back.
 * A newer archive replaces the toast, so only the latest one can be undone.
 *
 * The events are declared here rather than in `events.ts`, like the project
 * page's, so the vocabulary stays in one file.
 */
import type { RendererEvent } from './events';

export type ArchiveUndoEvent =
  /** You archived these sessions; the toast offers to bring them back. */
  | { type: 'archiveUndoOffered'; undo: Omit<ArchiveUndo, 'id'> }
  /** Undo was pressed, or the toast timed out or was put away. */
  | { type: 'archiveUndoClosed'; id: number };

/** One archive that can still be taken back. */
export interface ArchiveUndo {
  /** Counts the offers, so a timer left over from an older toast closes nothing. */
  readonly id: number;
  /** The sessions archived, in the order they went. */
  readonly sessionIds: readonly string[];
  /** What the toast calls it: a session's name, or "4 sessions". */
  readonly label: string;
  /** The rows and groups that slid out: they are marked leaving until undone. */
  readonly leavingIds: readonly string[];
  /** The session that was on screen, reopened by Undo. */
  readonly reopen: string | null;
}

export interface ArchiveUndoState {
  readonly undo: ArchiveUndo | null;
  /** The id the next offer takes. */
  readonly nextId: number;
}

export const initialArchiveUndoState: ArchiveUndoState = { undo: null, nextId: 1 };

export function archiveUndoReducer(state: ArchiveUndoState, event: RendererEvent): ArchiveUndoState {
  switch (event.type) {
    case 'archiveUndoOffered':
      if (!event.undo.sessionIds.length) return state;
      return { undo: { ...event.undo, id: state.nextId }, nextId: state.nextId + 1 };
    case 'archiveUndoClosed':
      return state.undo?.id === event.id ? { ...state, undo: null } : state;
    default:
      return state;
  }
}

/** A re-keyed session stays undoable under its new id; see `rekeyState` in `root`. */
export function rekeyArchiveUndo(state: ArchiveUndoState, oldId: string, newId: string): ArchiveUndoState {
  const { undo } = state;
  if (!undo || (!undo.sessionIds.includes(oldId) && undo.reopen !== oldId)) return state;
  return {
    ...state,
    undo: {
      ...undo,
      sessionIds: undo.sessionIds.map(id => (id === oldId ? newId : id)),
      reopen: undo.reopen === oldId ? newId : undo.reopen,
    },
  };
}

/** What the toast calls the archive: the one session's name, or how many went. */
export function archiveUndoLabel(names: readonly string[]): string {
  return names.length === 1 ? `“${names[0]}”` : `${names.length} sessions`;
}

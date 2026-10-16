/**
 * What the renderer knows about sessions right now.
 *
 * Three collections and one record of view state. The collections are exported
 * directly — nothing reassigns a Map, so a live binding is all anyone needs.
 * They stay plain registries outside the store: `openSessions` holds xterm
 * instances and DOM elements, and `sessionMap` and `pendingSessions` hold the
 * shared row objects that are mutated in place, none of which an immutable
 * store can hold. Everything reassignable lives on `view` instead, most of it
 * now in the store (see `view-slice`).
 */
import { dispatch, getState } from './app-store';
import { sessionKeyIn } from './keys-slice';
import { isFilteringView } from './view-slice';
import type { ViewState } from './view-slice';
import type { PendingSession } from '../../domain/session/pending';
import type { Project } from '../../domain/project/project';
import type { SessionRow } from '../../domain/session/session';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';

/** A session with a terminal on screen. */
export interface OpenSession {
  terminal: Terminal;
  /** The container React renders for the terminal (see `ui/terminal/TerminalSlot`). */
  element: HTMLElement;
  fitAddon: FitAddon;
  searchAddon?: SearchAddon;
  session: SessionRow;
  closed?: boolean;
  /** Set while the PTY has switched to the alternate screen buffer. */
  altScreen?: boolean;
  [key: string]: unknown;
}

/** One entry of the flat sidebar render order. */
export interface OrderedRow {
  id: string;
  tier: number;
}

// ── Collections ──

/** sessionId → the terminal and metadata of an open session. */
export const openSessions = new Map<string, OpenSession>();

/**
 * sessionId → the row the sidebar last rendered for it.
 *
 * Shared identity: every cached project's session array holds *these* objects,
 * so a rename or a star written through one is seen by all of them.
 */
export const sessionMap = new Map<string, SessionRow>();

/** Rows Claude has not written a transcript for yet. */
export const pendingSessions = new Map<string, PendingSession>();

// ── View state ──

export { STORAGE_KEYS, readStored, writeStored } from './storage';

/** The fields of `view` that live in the store; see `view-slice`. */
type StoredViewKey = keyof ViewState;

/**
 * The fields of `view` that do not: the cached project lists hold the shared
 * row objects every surface mutates in place, and `sortedOrder` is the
 * renderer's own memory between two of its renders. See `view-slice` for why.
 */
interface LocalView {
  cachedProjects: Project[];
  cachedAllProjects: Project[];
  /** Flat render order of the session list — the source of truth between renders. */
  sortedOrder: OrderedRow[];
}

type View = { -readonly [K in StoredViewKey]: ViewState[K] } & LocalView;

/**
 * The view state, as the vanilla code reads and writes it.
 *
 * An adapter over the store: reading a stored field reads the current state,
 * and assigning one dispatches it (as `viewPatched`), so `view.showArchived =
 * true` keeps working and every subscriber hears about it. Collections come
 * back read-only — `view.activePtyIds.delete(id)` would mutate the store
 * behind its back, so it is a compile error; dispatch an event instead.
 */
export const view: View = (() => {
  const local: LocalView = { cachedProjects: [], cachedAllProjects: [], sortedOrder: [] };
  const adapter = local as View;
  for (const key of Object.keys(getState().view) as StoredViewKey[]) {
    Object.defineProperty(adapter, key, {
      enumerable: true,
      get: () => getState().view[key],
      set: (value: unknown) => dispatch({ type: 'viewPatched', patch: { [key]: value } }),
    });
  }
  return adapter;
})();

/** A session's stable local key, for element keys; see `keys-slice`. */
export function sessionKey(sessionId: string): string {
  return sessionKeyIn(getState().keys, sessionId);
}

/** True when any filter or a search is narrowing the list. */
export function isFiltering(): boolean {
  return isFilteringView(getState().view);
}

/**
 * Merge freshly fetched projects into the shared session objects.
 *
 * The sidebar, the dialogs and the grid all hold references to rows; replacing
 * them wholesale on every fetch would strand those references on stale copies,
 * so an existing row is updated in place and reused.
 */
export function adoptSessions(projects: readonly Project[]): void {
  dispatch({ type: 'sessionsSeen', sessionIds: projects.flatMap(p => p.sessions.map(s => s.sessionId)) });
  for (const project of projects) {
    for (let i = 0; i < project.sessions.length; i++) {
      const fresh = project.sessions[i];
      const existing = sessionMap.get(fresh.sessionId);
      if (existing) {
        Object.assign(existing, fresh);
        project.sessions[i] = existing;
      } else {
        sessionMap.set(fresh.sessionId, fresh);
      }
    }
  }
}

/** Remove a session from both cached project lists. */
export function removeFromCaches(sessionId: string): void {
  for (const list of [view.cachedProjects, view.cachedAllProjects]) {
    for (const project of list) {
      project.sessions = project.sessions.filter(s => s.sessionId !== sessionId);
    }
  }
}

/**
 * Put a row into the cached lists so it appears in the sidebar immediately.
 *
 * A session the user just started has no transcript and so no cached row; the
 * sidebar would otherwise show nothing until the CLI has written one, which
 * takes long enough to look broken.
 */
export function injectIntoCaches(session: SessionRow, folder: string, remote = false): void {
  dispatch({ type: 'sessionsSeen', sessionIds: [session.sessionId] });
  sessionMap.set(session.sessionId, session);
  for (const list of [view.cachedProjects, view.cachedAllProjects]) {
    let project = list.find(p => p.projectPath === session.projectPath);
    if (!project) {
      project = { folder, projectPath: session.projectPath, sessions: [] };
      if (remote) project.remote = true;
      list.unshift(project);
    }
    if (!project.sessions.some(s => s.sessionId === session.sessionId)) {
      project.sessions.unshift(session);
    }
  }
}

/**
 * Follow a re-key in the three collections.
 *
 * The row is renamed in place rather than replaced: `sessionMap` and every
 * cached project list hold the same object (see `adoptSessions`), and so,
 * normally, do the open terminal and the pending entry — so one assignment
 * re-keys all of them, and only the Map keys are left to move. Should the
 * terminal or the pending entry hold a different copy, it is renamed too.
 */
export function rekeySessions(oldId: string, newId: string): void {
  if (oldId === newId) return;
  const entry = openSessions.get(oldId);
  const pending = pendingSessions.get(oldId);
  const row = sessionMap.get(oldId) ?? entry?.session ?? pending?.session;

  for (const copy of new Set([row, entry?.session, pending?.session])) {
    if (copy) copy.sessionId = newId;
  }
  if (entry) {
    openSessions.delete(oldId);
    openSessions.set(newId, entry);
  }
  if (pending) {
    pendingSessions.delete(oldId);
    pendingSessions.set(newId, pending);
  }
  sessionMap.delete(oldId);
  if (row) sessionMap.set(newId, row);
}

/**
 * What the renderer knows about sessions right now.
 *
 * Four collections and one record of view state. The collections are exported
 * directly — nothing reassigns a Map, so a live binding is all anyone needs.
 * Everything reassignable lives on `view` instead: an ES module can read an
 * imported `let` but not write to it, and a single mutable record is clearer
 * than a setter per field.
 */
import type { PendingSession } from '../../domain/session/pending';
import type { Project } from '../../domain/project/project';
import type { SessionRow } from '../../domain/session/session';
import type { PlanSummary } from '../../domain/plans/plan';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import type { SearchAddon } from '@xterm/addon-search';

/** A session with a terminal on screen. */
export interface OpenSession {
  terminal: Terminal;
  element: HTMLElement;
  fitAddon: FitAddon;
  searchAddon?: SearchAddon;
  openSearchBar?: () => void;
  closeSearchBar?: () => void;
  session: SessionRow;
  closed?: boolean;
  /** Set while the PTY has switched to the alternate screen buffer. */
  altScreen?: boolean;
  /** The last title the PTY set via OSC 0, shown next to the session name. */
  ptyTitle?: string;
  /** The connection card, built lazily for remote sessions only. */
  remoteCard?: HTMLElement;
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

/**
 * The keys view state is persisted under.
 *
 * Named here because both the read and the write have to agree: they used to be
 * spelled differently at the two ends ('activeSessionId' read, but
 * 'state.activeSessionId' written), which silently stopped the open session
 * being restored after a reload.
 */
export const STORAGE_KEYS = {
  activeSessionId: 'activeSessionId',
  gridViewActive: 'gridViewActive',
  expandedSlugs: 'expandedSlugs',
  scope: 'scope',
} as const;

/**
 * Web Storage, when there is any.
 *
 * The unit tests import this module in Node, where neither store exists — and a
 * browser with site data blocked throws on the property access itself, not just
 * on the call. Both are handled here so no caller has to.
 */
export function readStored(store: 'sessionStorage' | 'localStorage', key: string): string | null {
  try {
    return globalThis[store]?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write, or forget, a persisted value. Silent when there is no storage. */
export function writeStored(
  store: 'sessionStorage' | 'localStorage',
  key: string,
  value: string | null,
): void {
  try {
    if (value === null) globalThis[store]?.removeItem(key);
    else globalThis[store]?.setItem(key, value);
  } catch {
    // Site data blocked; the preference simply does not persist.
  }
}

export const view = {
  activeSessionId: readStored('sessionStorage', STORAGE_KEYS.activeSessionId),
  activeTab: 'sessions' as string,

  /** Session ids with a live PTY, as of the last poll. */
  activePtyIds: new Set<string>(),

  cachedProjects: [] as Project[],
  cachedAllProjects: [] as Project[],
  cachedPlans: [] as PlanSummary[],

  /** Flat render order of the session list — the source of truth between renders. */
  sortedOrder: [] as OrderedRow[],

  // Sidebar filters
  showArchived: false,
  showStarredOnly: false,
  showRunningOnly: false,
  showTodayOnly: false,

  /** null = no search active; a Set = the matched session ids. */
  searchMatchIds: null as Set<string> | null,
  /** Project paths matched by name, so their rows survive the filter. */
  searchMatchProjectPaths: null as Set<string> | null,

  gridViewActive: readStored('localStorage', STORAGE_KEYS.gridViewActive) === '1',
  visibleSessionCount: 25,
  sessionMaxAgeDays: 3,
};

/** True when any filter or a search is narrowing the list. */
export function isFiltering(): boolean {
  return view.showStarredOnly || view.showRunningOnly || view.showTodayOnly
    || view.showArchived || view.searchMatchIds !== null;
}

/**
 * Merge freshly fetched projects into the shared session objects.
 *
 * The sidebar, the dialogs and the grid all hold references to rows; replacing
 * them wholesale on every fetch would strand those references on stale copies,
 * so an existing row is updated in place and reused.
 */
export function adoptSessions(projects: readonly Project[]): void {
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

/** The project a session belongs to, as far as the cached lists know. */
export function projectOf(sessionId: string): Project | undefined {
  for (const list of [view.cachedAllProjects, view.cachedProjects]) {
    const found = list.find(p => p.sessions.some(s => s.sessionId === sessionId));
    if (found) return found;
  }
  return undefined;
}

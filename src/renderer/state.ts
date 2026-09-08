/**
 * Renderer state shared across modules.
 *
 * The collections are exported directly — nothing reassigns a Map or a Set, so
 * a live binding is all anyone needs. Everything reassignable lives on `state`
 * instead: an ES module can read an imported `let` but not write to it, and a
 * single mutable record is clearer than a setter per field (which is what the
 * old `window._setVisibleSessionCount` pair really was).
 */
import type { Project, RemoteStatusView, SessionRow } from '../shared/types.js';
import type { PlanSummary } from '../preload/index.js';
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
  [key: string]: unknown;
}

/** A row invented before Claude has written its transcript, so the list isn't empty. */
export interface PendingSession {
  session: SessionRow;
  projectPath: string;
  folder: string;
  /** When the PTY exited, if it did — starts the abandonment grace period. */
  exitedAt?: number;
}

/** One entry of the flat sidebar render order. */
export interface OrderedRow {
  id: string;
  tier: number;
}

// --- Collections (never reassigned) ---

/** sessionId → the terminal and metadata of an open session. */
export const openSessions = new Map<string, OpenSession>();
/** sessionId → the row the sidebar last rendered for it. */
export const sessionMap = new Map<string, SessionRow>();
/** sessionId → { session, projectPath, folder } for rows Claude hasn't written yet. */
export const pendingSessions = new Map<string, PendingSession>();
/** sessionId → last connection status main sent for a remote session. */
export const remoteStatus = new Map<string, RemoteStatusView>();
/** sessionId → whether a CLI turn is currently in flight. */
export const sessionBusyState = new Map<string, boolean>();
/** Sessions needing user action, per OSC 9. */
export const attentionSessions = new Set<string>();
/** Claude finished but the user hasn't looked yet. */
export const responseReadySessions = new Set<string>();

// --- Reassignable state ---

/**
 * Web Storage, when there is any.
 *
 * The unit tests import this module in Node, where neither store exists — and a
 * browser with site data blocked throws on the property access itself, not just
 * on the call. Both are handled here so no caller has to.
 */
function stored(store: 'sessionStorage' | 'localStorage', key: string): string | null {
  try {
    return globalThis[store]?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export const state = {
  activeSessionId: stored('sessionStorage', 'activeSessionId'),
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

  gridViewActive: stored('localStorage', 'gridViewActive') === '1',
  visibleSessionCount: 25,
  sessionMaxAgeDays: 3,
};

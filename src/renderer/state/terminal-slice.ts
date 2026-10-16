/**
 * The terminals' chrome: which sessions have a terminal slot, which one is on
 * screen, which search bars are open, and what the header above them says.
 *
 * Never the terminal itself. The xterm instances and their byte stream stay
 * outside the store (`openSessions`, `write-buffer`); this only holds what
 * React needs to decide which slots exist, which one shows, and what the bar
 * above it reads.
 *
 * "On screen" is its own field rather than `view.activeSessionId`: at boot the
 * active session is restored from storage before it is opened, and its
 * terminal and header must not appear until it is actually shown.
 */
import { movedEntry, withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';

/** One terminal container. `slotId` outlives a re-key; a relaunch gets a new one. */
export interface TerminalSlot {
  readonly slotId: number;
  readonly sessionId: string;
}

export interface TerminalState {
  /** The open terminals, oldest first. */
  readonly slots: readonly TerminalSlot[];
  /** The session whose terminal and header are on screen, or null. */
  readonly onScreen: string | null;
  /** sessionId → the title the process last set (OSC 0). */
  readonly titles: IdRecord<string>;
  /**
   * sessionId → how many times its search bar has been asked open; absent
   * when closed. A count rather than a flag, so asking again while it is open
   * (Cmd+F on a new selection) is a change the bar can act on.
   */
  readonly searches: IdRecord<number>;
  /** The header's name for the session on screen, as of when it was shown or renamed. */
  readonly headerName: string;
  /** A message from the CLI shown in place of the title, until the header next repaints. */
  readonly notice: string | null;
  /** The shell profile of the session on screen (looked up when shown); name null for the default. */
  readonly shell: { readonly sessionId: string; readonly name: string | null } | null;
}

export const initialTerminalState: TerminalState = {
  slots: [],
  onScreen: null,
  titles: {},
  searches: {},
  headerName: '',
  notice: null,
  shell: null,
};

export function terminalReducer(state: TerminalState, event: RendererEvent): TerminalState {
  switch (event.type) {
    case 'terminalOpened':
      return {
        ...state,
        slots: [...state.slots.filter(s => s.sessionId !== event.sessionId), { slotId: event.slotId, sessionId: event.sessionId }],
      };

    case 'terminalClosed': {
      if (!state.slots.some(s => s.sessionId === event.sessionId)) return state;
      return {
        ...state,
        slots: state.slots.filter(s => s.sessionId !== event.sessionId),
        titles: withoutEntry(state.titles, event.sessionId),
        searches: withoutEntry(state.searches, event.sessionId),
      };
    }

    case 'sessionShown':
      return { ...state, onScreen: event.sessionId, headerName: event.name, notice: null };

    // The screen was cleared; the only way the active session becomes none.
    case 'activeSessionChanged':
      return event.sessionId === null && state.onScreen !== null ? { ...state, onScreen: null } : state;

    case 'headerRenamed':
      return event.sessionId === state.onScreen && event.name !== state.headerName
        ? { ...state, headerName: event.name }
        : state;

    // Each tick of the connection countdown repaints the header too, as the
    // vanilla card's tick did.
    case 'headerRefreshed':
    case 'remoteTick':
      return state.notice === null ? state : { ...state, notice: null };

    case 'ptyTitleChanged': {
      const titles = withEntry(state.titles, event.sessionId, event.title);
      // A new title for the session on screen takes the notice's place.
      const notice = event.sessionId === state.onScreen ? null : state.notice;
      return titles === state.titles && notice === state.notice ? state : { ...state, titles, notice };
    }

    case 'terminalNotification':
      return event.sessionId === state.onScreen ? { ...state, notice: event.message } : state;

    // A lookup that lands after the user moved on is for nobody on screen.
    case 'shellProfileResolved':
      return event.sessionId === state.onScreen
        ? { ...state, shell: { sessionId: event.sessionId, name: event.name } }
        : state;

    case 'terminalSearchOpened':
      return { ...state, searches: withEntry(state.searches, event.sessionId, (state.searches[event.sessionId] ?? 0) + 1) };

    case 'terminalSearchClosed': {
      const searches = withoutEntry(state.searches, event.sessionId);
      return searches === state.searches ? state : { ...state, searches };
    }

    default:
      return state;
  }
}

/** A re-keyed session keeps its slot, its title, its search bar and its place on screen. */
export function rekeyTerminal(state: TerminalState, oldId: string, newId: string): TerminalState {
  if (oldId === newId) return state;
  const owns = (id: string | null | undefined) => id === oldId;
  if (!state.slots.some(s => owns(s.sessionId)) && !owns(state.onScreen) && !owns(state.shell?.sessionId)
    && !(oldId in state.titles) && !(oldId in state.searches)) {
    return state;
  }
  return {
    ...state,
    slots: state.slots.map(s => (owns(s.sessionId) ? { ...s, sessionId: newId } : s)),
    onScreen: owns(state.onScreen) ? newId : state.onScreen,
    titles: movedEntry(state.titles, oldId, newId),
    searches: movedEntry(state.searches, oldId, newId),
    shell: state.shell && owns(state.shell.sessionId) ? { ...state.shell, sessionId: newId } : state.shell,
  };
}

/** The text in the title's place: the notice, else the process title. */
export function headerTitleIn(state: TerminalState): string {
  if (state.notice !== null) return state.notice;
  return state.onScreen ? state.titles[state.onScreen] ?? '' : '';
}

/** The shell profile name to show for the session on screen, or null. */
export function headerShellIn(state: TerminalState): string | null {
  return state.shell && state.shell.sessionId === state.onScreen ? state.shell.name : null;
}

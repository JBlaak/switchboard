/**
 * What each session currently wants from the user.
 *
 * Three states, and the transitions between them are the whole point:
 *
 *   working        a CLI turn is in flight
 *   ready          it finished, and the user has not looked yet
 *   needs input    it is blocked on the user (an OSC 9 notification)
 *
 * Two signals feed this. The OSC 0 title spinner is authoritative and comes
 * from the main process, which already de-duplicates it into transitions. The
 * OSC 9 notifications are what the CLI sends when it actually needs someone.
 *
 * Alongside the state, which subagents the session has working (OSC 7501's
 * child records, de-duplicated in the main process like the busy state).
 *
 * Nothing here touches the DOM: the sidebar subscribes and puts the classes on
 * its rows (see `features/sessions/sidebar-activity`).
 */
import { hasEntry, movedEntry, withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';
import type { WorkingAgent } from '../../domain/terminal/program-status-children';

export interface ActivityState {
  /** Sessions blocked on the user, per OSC 9 or OSC 7501's `blocked`. */
  readonly attention: IdRecord<true>;
  /** Sessions that finished a turn the user has not looked at. */
  readonly ready: IdRecord<true>;
  /** sessionId → whether a CLI turn is currently in flight. */
  readonly busy: IdRecord<boolean>;
  /** sessionId → the subagents it has working. Absent means none. */
  readonly agents: IdRecord<readonly WorkingAgent[]>;
}

export const initialActivityState: ActivityState = {
  attention: {}, ready: {}, busy: {}, agents: {},
};

/** Notifications that mean the CLI is waiting for a person. */
const NEEDS_ATTENTION = /attention|approval|permission|needs your|wants to enter/i;
/** …and the one that is really a late idle signal. */
const WAITING_FOR_INPUT = /waiting for your input/i;

/**
 * `activeSessionId` is the session on screen when the event arrived: a session
 * the user is looking at has been read by definition, so it never goes unread
 * or waiting.
 */
export function activityReducer(
  state: ActivityState,
  event: RendererEvent,
  activeSessionId: string | null,
): ActivityState {
  switch (event.type) {
    case 'cliBusyState':
      return setBusy(state, event.sessionId, event.busy, activeSessionId);

    // OSC 7501's `blocked`: the same flag the OSC 9 permission text raises,
    // but stated outright. Both can arrive for one prompt; marking twice is
    // harmless.
    case 'sessionNeedsAttention':
      return markNeedsAttention(state, event.sessionId, activeSessionId);

    /**
     * Four of the CLI's messages mean "a person is needed": needs your
     * attention, needs your approval for the plan, needs your permission to use
     * a tool, and wants to enter plan mode. A fifth — "waiting for your input"
     * — is a late idle signal rather than a request, so it settles the session
     * instead of flagging it.
     */
    case 'terminalNotification':
      if (NEEDS_ATTENTION.test(event.message)) {
        return markNeedsAttention(state, event.sessionId, activeSessionId);
      }
      if (WAITING_FOR_INPUT.test(event.message)) {
        return setBusy(state, event.sessionId, false, activeSessionId);
      }
      return state;

    case 'sessionAgents':
      return patch(state, {
        agents: event.agents.length > 0
          ? withEntry(state.agents, event.sessionId, event.agents)
          : withoutEntry(state.agents, event.sessionId),
      });

    case 'sessionViewed':
      return patch(state, {
        ready: withoutEntry(state.ready, event.sessionId),
        attention: withoutEntry(state.attention, event.sessionId),
      });

    // Includes the agents: a CLI that died without its final `clear` would
    // otherwise leave them on the row for good.
    case 'activityCleared':
      return patch(state, {
        attention: withoutEntry(state.attention, event.sessionId),
        ready: withoutEntry(state.ready, event.sessionId),
        busy: withoutEntry(state.busy, event.sessionId),
        agents: withoutEntry(state.agents, event.sessionId),
      });

    default:
      return state;
  }
}

/**
 * Record a busy↔idle transition.
 *
 * Only real transitions reach here — the main process de-duplicates the title
 * stream — so this stays cheap.
 */
function setBusy(
  state: ActivityState, sessionId: string, active: boolean, activeSessionId: string | null,
): ActivityState {
  let ready = state.ready;
  // A turn starting again supersedes an unread answer: the row goes back to
  // working. Only an idle signal is ignored while unread — otherwise a late
  // idle repaint would clear a mark the user has not seen yet.
  if (hasEntry(ready, sessionId)) {
    if (!active) return state;
    ready = withoutEntry(ready, sessionId);
  }

  const wasActive = state.busy[sessionId] === true;
  // Activity ended → ready, but only if the user is not looking at it.
  if (wasActive && !active && sessionId !== activeSessionId) {
    ready = withEntry(ready, sessionId, true);
  }

  return patch(state, { ready, busy: withEntry(state.busy, sessionId, active) });
}

/** Mark a session as needing the user, unless they are already looking at it. */
function markNeedsAttention(
  state: ActivityState, sessionId: string, activeSessionId: string | null,
): ActivityState {
  if (sessionId === activeSessionId) return state;
  return patch(state, { attention: withEntry(state.attention, sessionId, true) });
}

/** `state` itself when none of the fields actually changed. */
function patch(state: ActivityState, fields: Partial<ActivityState>): ActivityState {
  for (const key of Object.keys(fields) as (keyof ActivityState)[]) {
    if (fields[key] !== state[key]) return { ...state, ...fields };
  }
  return state;
}

/** A re-keyed session keeps all four marks; see `rekeyState` in `root`. */
export function rekeyActivity(state: ActivityState, oldId: string, newId: string): ActivityState {
  return patch(state, {
    attention: movedEntry(state.attention, oldId, newId),
    ready: movedEntry(state.ready, oldId, newId),
    busy: movedEntry(state.busy, oldId, newId),
    agents: movedEntry(state.agents, oldId, newId),
  });
}

/** True when a session's busy flag differs between two states. */
export function busyChanged(previous: ActivityState, next: ActivityState, sessionId: string): boolean {
  return (previous.busy[sessionId] === true) !== (next.busy[sessionId] === true);
}

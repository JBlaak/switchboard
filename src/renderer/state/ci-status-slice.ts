/**
 * What the CI watch says about the running sessions' PRs: each row's chip
 * dots (W4), and the failing checks' logs the Checks panel has read.
 *
 * Main pushes a session's dots only when they changed, and an empty list when
 * nothing is known any more (the session stopped), which drops its entry: a
 * chip with no entry has no dot.
 */
import { worstStatusDot, type PullRequestStatusChange, type StatusDot } from '../../domain/session-work/status';
import { movedEntry, withEntry, withoutEntry, type IdRecord } from './records';
import type { RendererEvent } from './events';

/** A check run's log, by its URL: loading, or what main answered (null: none to show). */
export type CheckLog = { readonly loading: true } | { readonly loading: false; readonly text: string | null };

export interface CiStatusState {
  /** sessionId → its PRs' dots, as last pushed. */
  readonly bySession: IdRecord<PullRequestStatusChange>;
  /** Check run URL → its log. */
  readonly checkLogs: IdRecord<CheckLog>;
}

export const initialCiStatusState: CiStatusState = { bySession: {}, checkLogs: {} };

export function ciStatusReducer(state: CiStatusState, event: RendererEvent): CiStatusState {
  switch (event.type) {
    case 'prStatusChanged': {
      const { change } = event;
      const bySession = change.prs.length === 0 && !change.needsYou
        ? withoutEntry(state.bySession, change.sessionId)
        : withEntry(state.bySession, change.sessionId, change);
      return bySession === state.bySession ? state : { ...state, bySession };
    }
    case 'checkLogRequested':
      if (state.checkLogs[event.url]) return state;
      return { ...state, checkLogs: withEntry(state.checkLogs, event.url, { loading: true }) };
    case 'checkLogLoaded':
      return { ...state, checkLogs: withEntry(state.checkLogs, event.url, { loading: false, text: event.text }) };
    default:
      return state;
  }
}

/** A re-keyed session keeps its dots; see `rekeyState` in `root`. */
export function rekeyCiStatus(state: CiStatusState, oldId: string, newId: string): CiStatusState {
  const bySession = movedEntry(state.bySession, oldId, newId);
  return bySession === state.bySession ? state : { ...state, bySession };
}

/** A PR chip's dot, by PR number; null when the watch has said nothing about it. */
export function chipDot(change: PullRequestStatusChange | undefined, number: number): StatusDot | null {
  return change?.prs.find((pr) => pr.number === number)?.dot ?? null;
}

/** The `+N` chip's dot: the worst of the PRs it hides that have one. */
export function hiddenChipsDot(change: PullRequestStatusChange | undefined, numbers: readonly number[]): StatusDot | null {
  const dots: StatusDot[] = [];
  for (const number of numbers) {
    const dot = chipDot(change, number);
    if (dot) dots.push(dot);
  }
  return worstStatusDot(dots);
}

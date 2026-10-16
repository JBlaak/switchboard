/**
 * What a sidebar row shows of its session's activity, derived from state.
 *
 * Pure, so the rule for each class is written once and tested in node; each
 * row of the session list selects its own (`ui/session-list/SessionItem`).
 */
import { hasEntry } from './records';
import { askingCountIn } from './questions-slice';
import type { RendererState } from './root';
import type { WorkingAgent } from '../../domain/terminal/program-status-children';

export interface RowActivity {
  /** `needs-attention`: blocked on the user, or asking questions. */
  readonly needsAttention: boolean;
  /** `response-ready`: finished a turn the user has not looked at. */
  readonly responseReady: boolean;
  /** `cli-busy`: a turn is in flight. */
  readonly busy: boolean;
  /** The agents badge; empty means no badge. */
  readonly agents: readonly WorkingAgent[];
}

const NO_AGENTS: readonly WorkingAgent[] = [];

export function rowActivity(state: RendererState, sessionId: string): RowActivity {
  const { activity, questions } = state;
  return {
    // A session asking questions is waiting on the user just as surely, and
    // stays so while it is on screen: it is cleared by the set settling.
    needsAttention: hasEntry(activity.attention, sessionId) || askingCountIn(questions, sessionId) > 0,
    responseReady: hasEntry(activity.ready, sessionId),
    busy: activity.busy[sessionId] === true,
    agents: activity.agents[sessionId] ?? NO_AGENTS,
  };
}

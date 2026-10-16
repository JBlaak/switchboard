/**
 * What a sidebar row shows of its session's activity, derived from state.
 *
 * Pure, so the rule for each class is written once and tested in node: the
 * sidebar applies these to rows already on screen, and the row builder reads
 * the same signals when it builds one.
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

/** One row whose activity differs between two states, with what changed. */
export interface RowActivityChange {
  readonly sessionId: string;
  readonly next: RowActivity;
  /** The classes to set, only those that changed. */
  readonly classes: Readonly<Partial<Record<'needs-attention' | 'response-ready' | 'cli-busy', boolean>>>;
  /** True when the agents badge has to be redrawn. */
  readonly agentsChanged: boolean;
}

/**
 * The rows whose activity changed between `previous` and `next`.
 *
 * Only the sessions either state mentions can have changed, so only those are
 * looked at; and nothing at all when neither slice moved, which is most
 * events.
 */
export function rowActivityChanges(previous: RendererState, next: RendererState): RowActivityChange[] {
  if (previous.activity === next.activity && previous.questions.bySession === next.questions.bySession) {
    return [];
  }

  const ids = new Set<string>();
  for (const state of [previous, next]) {
    const { attention, ready, busy, agents } = state.activity;
    for (const record of [attention, ready, busy, agents, state.questions.bySession]) {
      for (const id of Object.keys(record)) ids.add(id);
    }
  }

  const changes: RowActivityChange[] = [];
  for (const sessionId of ids) {
    const before = rowActivity(previous, sessionId);
    const after = rowActivity(next, sessionId);
    const classes: Partial<Record<'needs-attention' | 'response-ready' | 'cli-busy', boolean>> = {};
    if (before.needsAttention !== after.needsAttention) classes['needs-attention'] = after.needsAttention;
    if (before.responseReady !== after.responseReady) classes['response-ready'] = after.responseReady;
    if (before.busy !== after.busy) classes['cli-busy'] = after.busy;
    const agentsChanged = before.agents !== after.agents;
    if (Object.keys(classes).length || agentsChanged) {
      changes.push({ sessionId, next: after, classes, agentsChanged });
    }
  }
  return changes;
}

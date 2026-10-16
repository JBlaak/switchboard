/**
 * The questions sessions are blocked on, as the main process last said.
 *
 * One set per session id at most, keyed by the session's current id so it
 * follows the same re-keys `openSessions` does (a new session's real id, a
 * fork): main sends later events under the new id, which is why a set has to
 * move rather than be looked up by the old one.
 *
 * Only what main said lives here. How far the user got answering — the draft,
 * whether they chose the terminal instead, Patch's bookkeeping — is the
 * question panel's own working state, mutated in place as the user types, and
 * stays beside this in `question-store`.
 */
import { withEntry, withoutEntry } from './records';
import type { IdRecord } from './records';
import type { RendererEvent } from './events';
import type { PendingQuestions } from '../../domain/questions/question';

export interface QuestionsState {
  /** sessionId → the set it is asking. */
  readonly bySession: IdRecord<PendingQuestions>;
  /**
   * Tool-use ids already settled. The bootstrap fetch can resolve after a set
   * it returned was settled by an event, and must not bring that set back.
   */
  readonly settled: IdRecord<true>;
}

export const initialQuestionsState: QuestionsState = { bySession: {}, settled: {} };

export function questionsReducer(state: QuestionsState, event: RendererEvent): QuestionsState {
  switch (event.type) {
    // A session has at most one set at a time, so a different set replaces
    // whatever was there; the same set again is ignored, keeping the draft.
    case 'questionsAsked': {
      const { pending } = event;
      if (state.settled[pending.toolUseId]) return state;
      if (state.bySession[pending.sessionId]?.toolUseId === pending.toolUseId) return state;
      return { ...state, bySession: withEntry(state.bySession, pending.sessionId, pending) };
    }

    // Found by tool-use id, because that cannot be stale; a set this renderer
    // never heard of is only remembered as settled.
    case 'questionsSettled': {
      const { toolUseId } = event.settled;
      const sessionId = sessionAsking(state, toolUseId);
      const settled = withEntry(state.settled, toolUseId, true);
      const bySession = sessionId ? withoutEntry(state.bySession, sessionId) : state.bySession;
      if (settled === state.settled && bySession === state.bySession) return state;
      return { bySession, settled };
    }

    case 'sessionForked': {
      const { oldId, newId } = event;
      const pending = state.bySession[oldId];
      if (!pending || oldId === newId) return state;
      let bySession = withoutEntry(state.bySession, oldId);
      // Main already asked again under the new id: that set is the live one.
      if (!bySession[newId]) bySession = withEntry(bySession, newId, { ...pending, sessionId: newId });
      return { ...state, bySession };
    }

    default:
      return state;
  }
}

/** Which session is asking the set with this tool-use id, if any. */
export function sessionAsking(state: QuestionsState, toolUseId: string): string | null {
  for (const [sessionId, pending] of Object.entries(state.bySession)) {
    if (pending.toolUseId === toolUseId) return sessionId;
  }
  return null;
}

/** How many questions a session is asking; 0 when it is asking none. */
export function askingCountIn(state: QuestionsState, sessionId: string): number {
  return state.bySession[sessionId]?.questions.length ?? 0;
}

/**
 * The questions sessions are blocked on, and how far the user got answering.
 *
 * One entry per session id: the pending set main told us about, plus what the
 * renderer adds to it — the draft and whether the user chose to answer in the
 * terminal instead. Kept here rather than in the panel because the panel only
 * ever shows one session, and switching away from a half-answered set and back
 * must find it as it was left.
 *
 * Keyed by the session's current id, so it follows the same re-keys
 * `openSessions` does (a new session's real id, a fork). Main sends later
 * events under the new id, which is why the entry has to move rather than be
 * looked up by the old one.
 */
import { createDraft } from '../../domain/questions/answer-draft';
import type { AnswerDraft } from '../../domain/questions/answer-draft';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';

/** Which of the two things a session with questions shows over its terminal area. */
export type QuestionView = 'questions' | 'terminal';

export interface QuestionEntry {
  pending: PendingQuestions;
  draft: AnswerDraft;
  view: QuestionView;
  /** Patch has said hello to this set; a later showing is a return, not an arrival. */
  greeted: boolean;
  /** How many times Patch has been poked beside this set, for its cycle of lines. */
  pokes: number;
  /** The minutes-left Patch last dozed on, so the reminder plays once per minute. */
  dozedAt: number | null;
  /** The answers are on their way to main; the set takes no more input. */
  sending: boolean;
}

export type QuestionChange =
  | { kind: 'asked'; sessionId: string }
  | { kind: 'settled'; sessionId: string; entry: QuestionEntry; outcome: QuestionsSettled['outcome'] }
  | { kind: 'rekeyed'; oldId: string; newId: string };

const entries = new Map<string, QuestionEntry>();
/**
 * Tool-use ids already settled. The bootstrap fetch can resolve after a set it
 * returned was settled by an event, and must not bring that set back.
 */
const settledToolUses = new Set<string>();
const listeners = new Set<(change: QuestionChange) => void>();

export function questionsFor(sessionId: string | null | undefined): QuestionEntry | undefined {
  return sessionId ? entries.get(sessionId) : undefined;
}

/** How many questions a session is asking; 0 when it is asking none. */
export function askingCount(sessionId: string): number {
  return entries.get(sessionId)?.pending.questions.length ?? 0;
}

export function onQuestionsChange(listener: (change: QuestionChange) => void): void {
  listeners.add(listener);
}

function emit(change: QuestionChange): void {
  for (const listener of listeners) listener(change);
}

/**
 * A session asked. A session has at most one set at a time, so a different
 * set replaces whatever was there; the same set again is ignored, keeping the
 * draft.
 */
export function addPendingQuestions(pending: PendingQuestions): void {
  if (settledToolUses.has(pending.toolUseId)) return;
  const existing = entries.get(pending.sessionId);
  if (existing?.pending.toolUseId === pending.toolUseId) return;
  entries.set(pending.sessionId, {
    pending,
    draft: createDraft(pending.questions),
    view: 'questions',
    greeted: false,
    pokes: 0,
    dozedAt: null,
    sending: false,
  });
  emit({ kind: 'asked', sessionId: pending.sessionId });
}

/**
 * A set ended. Found by tool-use id first, because that cannot be stale; the
 * session id is the fallback for a set this renderer never heard of.
 */
export function settleQuestions(settled: QuestionsSettled): void {
  settledToolUses.add(settled.toolUseId);
  let sessionId: string | null = null;
  for (const [id, entry] of entries) {
    if (entry.pending.toolUseId === settled.toolUseId) { sessionId = id; break; }
  }
  if (!sessionId) return;
  const entry = entries.get(sessionId)!;
  entries.delete(sessionId);
  emit({ kind: 'settled', sessionId, entry, outcome: settled.outcome });
}

/** Move a session's set to its new id. */
export function rekeyQuestions(oldId: string, newId: string): void {
  const entry = entries.get(oldId);
  if (!entry || oldId === newId) return;
  entries.delete(oldId);
  // Main already asked again under the new id: that set is the live one.
  if (!entries.has(newId)) {
    entry.pending = { ...entry.pending, sessionId: newId };
    entries.set(newId, entry);
  }
  emit({ kind: 'rekeyed', oldId, newId });
}

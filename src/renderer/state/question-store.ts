/**
 * The questions sessions are blocked on, and how far the user got answering.
 *
 * Two halves. Which sets are pending is store state (see `questions-slice`):
 * main pushes it, and the sidebar and the header read it. How far the user got
 * — the draft, whether they chose to answer in the terminal instead, Patch's
 * bookkeeping — is the question panel's working state, which it mutates in
 * place as the user types and compares by identity to tell "the set I am
 * showing" from "another set". That half stays here, one entry per set, keyed
 * by tool-use id so it survives the set being re-keyed to a new session id.
 *
 * Kept here rather than in the panel because the panel only ever shows one
 * session, and switching away from a half-answered set and back must find it
 * as it was left.
 */
import { createDraft } from '../../domain/questions/answer-draft';
import { dispatch, getState, store } from './app-store';
import { askingCountIn, sessionAsking } from './questions-slice';
import type { AnswerDraft } from '../../domain/questions/answer-draft';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';
import type { RendererState } from './root';
import type { RendererEvent } from './events';

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

/** toolUseId → the panel's working state for that set. */
const entries = new Map<string, QuestionEntry>();
const listeners = new Set<(change: QuestionChange) => void>();
let unsubscribe: (() => void) | null = null;

/**
 * The entry for the set a session is asking, made on first use.
 *
 * Answers the same object for as long as the set is pending, so the panel can
 * hold it and write to it; a re-key only points its `pending` at the moved set.
 */
export function questionsFor(sessionId: string | null | undefined): QuestionEntry | undefined {
  const pending = sessionId ? getState().questions.bySession[sessionId] : undefined;
  return pending ? entryFor(pending) : undefined;
}

function entryFor(pending: PendingQuestions): QuestionEntry {
  let entry = entries.get(pending.toolUseId);
  if (!entry) {
    entry = {
      pending,
      draft: createDraft(pending.questions),
      view: 'questions',
      greeted: false,
      pokes: 0,
      dozedAt: null,
      sending: false,
    };
    entries.set(pending.toolUseId, entry);
  }
  entry.pending = pending;
  return entry;
}

/** How many questions a session is asking; 0 when it is asking none. */
export function askingCount(sessionId: string): number {
  return askingCountIn(getState().questions, sessionId);
}

/**
 * Be told when a set is asked, settled or re-keyed.
 *
 * The store subscription is made on the first call rather than at import, so
 * it runs after the IPC follow-ups (installed earlier in `bootstrap`): a
 * re-key has to have moved `openSessions` before the panel looks for the
 * session under its new id.
 */
export function onQuestionsChange(listener: (change: QuestionChange) => void): void {
  listeners.add(listener);
  unsubscribe ??= store.subscribe(onTransition);
}

function onTransition(state: RendererState, previous: RendererState, event: RendererEvent): void {
  const before = previous.questions;
  const after = state.questions;
  if (before === after) return;

  switch (event.type) {
    case 'questionsAsked':
      if (before.bySession !== after.bySession) emit({ kind: 'asked', sessionId: event.pending.sessionId });
      break;

    case 'questionsSettled': {
      const sessionId = sessionAsking(before, event.settled.toolUseId);
      const pending = sessionId ? before.bySession[sessionId] : undefined;
      if (sessionId && pending) {
        const entry = entryFor(pending);
        entries.delete(pending.toolUseId);
        emit({ kind: 'settled', sessionId, entry, outcome: event.settled.outcome });
      }
      break;
    }

    case 'sessionForked':
      emit({ kind: 'rekeyed', oldId: event.oldId, newId: event.newId });
      break;
  }

  // A set replaced by another for the same session leaves its entry behind.
  const live = new Set(Object.values(after.bySession).map(p => p.toolUseId));
  for (const toolUseId of entries.keys()) if (!live.has(toolUseId)) entries.delete(toolUseId);
}

function emit(change: QuestionChange): void {
  for (const listener of listeners) listener(change);
}

/** A session asked; see `questionsReducer` for when that replaces a set. */
export function addPendingQuestions(pending: PendingQuestions): void {
  dispatch({ type: 'questionsAsked', pending });
}

/** A set ended, here or in main. */
export function settleQuestions(settled: QuestionsSettled): void {
  dispatch({ type: 'questionsSettled', settled });
}

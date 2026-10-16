/**
 * The vanilla code's way into the questions sessions are blocked on.
 *
 * Which sets are pending is store state (see `questions-slice`), and how far
 * the user got answering them is too (see `answers-slice`); the question
 * panel reads both itself. What is left here is what the sidebar and the
 * activity rows still ask for, and the two ways a set starts and ends.
 */
import { dispatch, getState } from './app-store';
import { askingCountIn } from './questions-slice';
import type { PendingQuestions, QuestionsSettled } from '../../domain/questions/question';

/** How many questions a session is asking; 0 when it is asking none. */
export function askingCount(sessionId: string): number {
  return askingCountIn(getState().questions, sessionId);
}

/** A session asked; see `questionsReducer` for when that replaces a set. */
export function addPendingQuestions(pending: PendingQuestions): void {
  dispatch({ type: 'questionsAsked', pending });
}

/** A set ended, here or in main. */
export function settleQuestions(settled: QuestionsSettled): void {
  dispatch({ type: 'questionsSettled', settled });
}

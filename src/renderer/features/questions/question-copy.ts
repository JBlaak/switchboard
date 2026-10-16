/**
 * The words around the question panel that are not Patch's: the counter, the
 * key hints, the header pill, and when Patch should start dozing.
 *
 * No DOM here, so the arithmetic in them (the "1–5" range, rounding the
 * minutes up) can be tested without a window.
 */
import { DOZE_FROM_MINUTES } from '../../../domain/companion/question-beats';
import type { Question } from '../../../domain/questions/question';

/** "Question 2 of 3", plus "· pick any" on a multiple-choice question. Uppercased by CSS. */
export function questionCounter(step: number, total: number, question: Question): string {
  return `Question ${step + 1} of ${total}` + (question.multiSelect ? ' · pick any' : '');
}

export interface KeyHint {
  key: string;
  does: string;
}

/**
 * The hint row under the options.
 *
 * The number range stops at 9, because that is as far as a single key goes;
 * Claude asks with at most four options, so it never does in practice.
 */
export function keyHints(question: Question): KeyHint[] {
  const rows = Math.min(question.options.length + 1, 9);
  const numbers = `1–${rows}`;
  return question.multiSelect
    ? [
      { key: '↑↓', does: 'move' },
      { key: numbers, does: 'toggle' },
      { key: 'space', does: 'toggle' },
      { key: '←→', does: 'questions' },
    ]
    : [
      { key: '↑↓', does: 'choose' },
      { key: numbers, does: 'pick' },
      { key: '←→', does: 'questions' },
    ];
}

/** Under Patch: "1 of 3 answered". */
export function answeredFoot(done: number, total: number): string {
  return `${done} of ${total} answered`;
}

/** The header pill while the user answers in the terminal instead. */
export function waitingLabel(unanswered: number): string {
  if (unanswered <= 0) return 'Ready to send · Show';
  return `${unanswered} ${unanswered === 1 ? 'question' : 'questions'} waiting · Show`;
}

/** Whole minutes until the terminal takes over, rounded up; 0 once it has. */
export function minutesLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 60_000));
}

/**
 * The minutes-left Patch should doze on now, or null when it should not.
 *
 * Once per minute: `lastDozed` is the value it last dozed on, so a timer that
 * ticks several times a minute replays the reminder only when the number
 * changes.
 */
export function dozeMinute(deadline: number, now: number, lastDozed: number | null): number | null {
  const left = minutesLeft(deadline, now);
  if (left <= 0 || left > DOZE_FROM_MINUTES) return null;
  return left === lastDozed ? null : left;
}

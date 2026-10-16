/**
 * What Patch says and does beside a set of questions.
 *
 * On the empty screen Patch reads the board; here it keeps someone company
 * while they answer, and has one real job: when the questions have been
 * waiting a while it dozes and says when the terminal will take over, which is
 * the only place that timeout is visible.
 */
import type { DraftEvent } from '../questions/answer-draft';
import type { PatchMood, PatchMove } from './patch';

/** One reaction: the move, the face it ends on, and the line in its bubble. */
export interface QuestionBeat {
  move: PatchMove;
  mood: PatchMood;
  line: string;
}

export type QuestionMoment =
  | DraftEvent
  /** The questions came up; `count` is how many there are. */
  | { kind: 'arrived'; count: number }
  /** Came back from the terminal view to unfinished questions. */
  | { kind: 'returned' }
  /** Patch was clicked; `count` is how many times so far. */
  | { kind: 'poked'; count: number }
  /** Time is running out; `minutesLeft` rounded up. */
  | { kind: 'waiting'; minutesLeft: number }
  /** The answers went to Claude. */
  | { kind: 'sent' };

/** Patch starts dozing, and saying so, once this many minutes or fewer remain. */
export const DOZE_FROM_MINUTES = 3;

/**
 * The beat for a moment.
 *
 * Lines, from the approved design: arrived "Claude has 3 questions for you.
 * I'll keep count!" (1 → "a question"); picked recommended "Good call. Claude
 * liked that one too."; picked other "Going your own way. I like it.";
 * unpicked "Changed your mind? Fair."; multi-count "Two picked. Any more?",
 * all of them "All of them? Bold.", none "Nothing picked yet…"; started-other
 * "Ooh, writing your own answer."; all-answered "That's everything. Send it!";
 * advanced "One down, two to go." / landing on the last "Last one!";
 * moved-to "Back to Timeout."; blocked "Pick one first!" / on the last
 * "Almost! One still needs an answer."; returned "Welcome back. Right where you
 * left off."; poked cycles "Hey! I'm counting.", "Hehe. That tickles.", "Okay
 * okay, I'm watching.", "Answer the questions, not me!"; waiting "Still here.
 * The terminal takes over in 3 min." (1 → "in a minute"); sent "Off it goes!".
 * Moves and moods only from PatchMove/PatchMood (dozing is `doze` + `tired`).
 */
export function questionBeat(moment: QuestionMoment): QuestionBeat {
  switch (moment.kind) {
    case 'arrived': {
      const what = moment.count === 1 ? 'a question' : `${moment.count} questions`;
      return { move: 'wave', mood: 'happy', line: `Claude has ${what} for you. I’ll keep count!` };
    }
    case 'picked':
      return moment.recommended
        ? { move: 'hop', mood: 'happy', line: 'Good call. Claude liked that one too.' }
        : { move: 'twirl', mood: 'happy', line: 'Going your own way. I like it.' };
    case 'unpicked':
      return { move: 'peek', mood: 'calm', line: 'Changed your mind? Fair.' };
    case 'multi-count':
      if (moment.count === 0) return { move: 'peek', mood: 'calm', line: 'Nothing picked yet…' };
      if (moment.count >= moment.total) return { move: 'jelly', mood: 'happy', line: 'All of them? Bold.' };
      return { move: 'hop', mood: 'happy', line: `${capitalised(inWords(moment.count))} picked. Any more?` };
    case 'started-other':
      return { move: 'peek', mood: 'calm', line: 'Ooh, writing your own answer.' };
    case 'all-answered':
      return { move: 'hop', mood: 'happy', line: 'That’s everything. Send it!' };
    case 'advanced': {
      if (moment.isLast) return { move: 'hop', mood: 'happy', line: 'Last one!' };
      const remaining = moment.total - moment.done;
      // Stepping forward through questions answered earlier can leave none to go.
      if (remaining <= 0) return { move: 'hop', mood: 'happy', line: 'All answered. Onward!' };
      return {
        move: 'hop',
        mood: 'happy',
        line: `${capitalised(inWords(moment.done))} down, ${inWords(remaining)} to go.`,
      };
    }
    case 'moved-to':
      return { move: 'peek', mood: 'calm', line: `Back to ${moment.header}.` };
    case 'blocked':
      return moment.isLast
        ? { move: 'jelly', mood: 'worried', line: 'Almost! One still needs an answer.' }
        : { move: 'jelly', mood: 'worried', line: 'Pick one first!' };
    case 'returned':
      return { move: 'wave', mood: 'happy', line: 'Welcome back. Right where you left off.' };
    case 'poked': {
      const n = POKE_LINES.length;
      return { move: 'jelly', mood: 'happy', line: POKE_LINES[(((moment.count - 1) % n) + n) % n] };
    }
    case 'waiting': {
      const when = moment.minutesLeft <= 1 ? 'in a minute' : `in ${moment.minutesLeft} min`;
      return { move: 'doze', mood: 'tired', line: `Still here. The terminal takes over ${when}.` };
    }
    // Asking to submit and having sent are the same moment from where Patch stands.
    case 'submit':
    case 'sent':
      return { move: 'love', mood: 'happy', line: 'Off it goes!' };
  }
}

const POKE_LINES = [
  'Hey! I’m counting.',
  'Hehe. That tickles.',
  'Okay okay, I’m watching.',
  'Answer the questions, not me!',
];

/** A set holds at most four questions or options in practice; digits are the fallback past that. */
function inWords(n: number): string {
  return ['zero', 'one', 'two', 'three', 'four'][n] ?? String(n);
}

function capitalised(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

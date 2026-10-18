/**
 * Asking Patch (#135): the box under Patch on the empty screen, and what came
 * of the last thing typed into it.
 *
 * The box is in one of three phases. While `editing` it is an ordinary text
 * field. Enter sends what is in it and it goes `waiting`: locked, the text
 * still in it, until main answers which project the text is about. A sure
 * answer starts the session and clears the box; an unsure one goes
 * `choosing`, a short list of projects under the box; anything else hands the
 * text to the New Session picker and goes back to editing (O1–O3).
 *
 * The text survives a hand-off to the picker, since the user may dismiss it
 * and edit; `handedOff` remembers that the picker is carrying this text, so a
 * session started from it clears the box.
 *
 * What an answer means is decided once, by `askOutcome`: the reducer moves
 * the box on it, and the actions do the matching launch or hand-off.
 */
import type { RouteResult } from '../../domain/ask/model';
import type { RendererEvent } from './events';

export type AskPhase = 'editing' | 'waiting' | 'choosing';

export interface AskState {
  readonly phase: AskPhase;
  /** What is in the box, exactly as typed. */
  readonly text: string;
  /** Counts every send, so the answer to one the user has cancelled is dropped. */
  readonly asked: number;
  /** While choosing: the candidate project paths, best first. */
  readonly choices: readonly string[];
  /** While choosing: the highlighted choice. */
  readonly selected: number;
  /** While choosing: the rewritten prompt a choice starts on. */
  readonly prompt: string;
  /** The New Session picker was opened carrying this text (or its rewrite). */
  readonly handedOff: boolean;
}

export const initialAskState: AskState = {
  phase: 'editing', text: '', asked: 0, choices: [], selected: 0, prompt: '', handedOff: false,
};

/** The most projects an unsure answer lists (O2). */
export const MAX_CHOICES = 3;

/**
 * What an answer comes to.
 *
 * `say` is Patch's line, where it has one; a sure answer has none, since the
 * session takes the screen.
 */
export type AskOutcome =
  /** Start a session in this project on this prompt (O1, or a choice made). */
  | { readonly kind: 'start'; readonly projectPath: string; readonly prompt: string }
  /** List these projects to choose from (O2). */
  | { readonly kind: 'choose'; readonly choices: readonly string[]; readonly prompt: string }
  /** Open the New Session picker carrying this prompt (O3). */
  | { readonly kind: 'picker'; readonly prompt: string; readonly say: string }
  /** Back to editing, nothing else (a cancel). */
  | { readonly kind: 'unlock' };

/**
 * What to do with `result`, the answer to `text`.
 *
 * On the fallback path nothing was rewritten, so the picker carries the text
 * exactly as typed (P3). An unsure answer with no candidates left has nothing
 * to list, so it falls back too, though with the prompt it did rewrite.
 */
export function askOutcome(result: RouteResult, text: string): AskOutcome {
  switch (result.kind) {
    case 'confident':
      return { kind: 'start', projectPath: result.projectPath, prompt: result.prompt };
    case 'unsure': {
      const choices = [...new Set(result.candidates)].slice(0, MAX_CHOICES);
      return choices.length > 0
        ? { kind: 'choose', choices, prompt: result.prompt }
        : { kind: 'picker', prompt: result.prompt, say: 'I’m not sure which project that is.' };
    }
    case 'noMatch':
    case 'failed':
      return { kind: 'picker', prompt: text, say: result.reason };
    case 'cancelled':
      return { kind: 'unlock' };
  }
}

/** Something to send: Enter on blank space is ignored. */
export function canSend(text: string): boolean {
  return text.trim() !== '';
}

export function askReducer(state: AskState, event: RendererEvent): AskState {
  switch (event.type) {
    case 'askTextChanged':
      if (state.phase !== 'editing' || event.text === state.text) return state;
      return { ...state, text: event.text, handedOff: false };

    case 'askSent':
      if (state.phase !== 'editing' || !canSend(state.text)) return state;
      return { ...state, phase: 'waiting', asked: state.asked + 1, handedOff: false };

    // Unlocked straight away; main's `cancelled` answer comes later and is dropped.
    case 'askCancelled':
      return state.phase === 'waiting' ? { ...state, phase: 'editing' } : state;

    case 'askAnswered':
      if (state.phase !== 'waiting' || event.asked !== state.asked) return state;
      return answered(state, askOutcome(event.result, state.text));

    case 'askChoiceStepped': {
      if (state.phase !== 'choosing') return state;
      const n = state.choices.length;
      return { ...state, selected: (((state.selected + event.step) % n) + n) % n };
    }

    case 'askChoiceHovered':
      if (state.phase !== 'choosing' || event.index < 0 || event.index >= state.choices.length) return state;
      return event.index === state.selected ? state : { ...state, selected: event.index };

    // A choice started its session.
    case 'askChoiceStarted':
      return state.phase === 'choosing' ? { ...closedChoices(state), text: '' } : state;

    // Esc: back to the box to edit.
    case 'askChoicesClosed':
      return state.phase === 'choosing' ? closedChoices(state) : state;

    // Tab: the full picker takes over, carrying the rewritten prompt.
    case 'askChoicesHandedOff':
      return state.phase === 'choosing' ? { ...closedChoices(state), handedOff: true } : state;

    // The picker started a session on what it carried, so the box has done its job.
    case 'pickerPromptLaunched':
      return state.handedOff ? { ...state, text: '', handedOff: false } : state;

    default:
      return state;
  }
}

/** The box once an answer has come to `outcome`. */
function answered(state: AskState, outcome: AskOutcome): AskState {
  switch (outcome.kind) {
    case 'start':
      return { ...state, phase: 'editing', text: '' };
    case 'choose':
      return { ...state, phase: 'choosing', choices: outcome.choices, selected: 0, prompt: outcome.prompt };
    case 'picker':
      return { ...state, phase: 'editing', handedOff: true };
    case 'unlock':
      return { ...state, phase: 'editing' };
  }
}

function closedChoices(state: AskState): AskState {
  return { ...state, phase: 'editing', choices: [], selected: 0, prompt: '' };
}

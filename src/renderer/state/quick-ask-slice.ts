/**
 * The Quick Ask pop-up (#142): the empty screen's box, and what the pop-up
 * shows once a send has come to something.
 *
 * The box itself is `ask-slice`'s, moved by its own reducer: editing, waiting
 * and choosing mean what they mean on the empty screen. What the pop-up adds
 * is the `result` on top of the box: "Started in ‹folder›" for 0.7 s before
 * it closes (B7), a capture being saved, the saved line, and ⌘Z taking it
 * back (C4). Main does the routing (R1), so an answer is a `QuickAskReply`,
 * not a `RouteResult`.
 *
 * The draft lives here, in the pop-up's memory: closing keeps it, and only a
 * session started or a capture saved clears it (B6). A capture undone puts it
 * back, so the saved line holds on to it until the pop-up closes.
 */
import { askReducer, initialAskState } from './ask-slice';
import type { AskPhase, AskState } from './ask-slice';
import type { RendererEvent } from './events';
import type { CaptureTarget, QuickAskReply } from '../../ipc/quick-ask-api';

export type QuickAskPhase = AskPhase | 'started' | 'saving' | 'saved' | 'undoing' | 'undone';

/** What the pop-up shows in place of the box's own phase. */
export type QuickAskResult =
  | { readonly kind: 'started'; readonly folder: string }
  | { readonly kind: 'saving'; readonly target: CaptureTarget }
  /** `text` is the draft the capture cleared, for ⌘Z to put back. */
  | { readonly kind: 'saved'; readonly target: CaptureTarget; readonly summary: string; readonly text: string }
  | { readonly kind: 'undoing'; readonly target: CaptureTarget; readonly summary: string; readonly text: string }
  /** "Undone", for a moment, before the text goes back in the box. */
  | { readonly kind: 'undone'; readonly text: string };

const TARGET_NAMES: Record<CaptureTarget, string> = { tasks: 'BlaakTasks', james: 'James' };

/** The line while a capture is written (C4). */
export function savingLine(target: CaptureTarget): string {
  return target === 'tasks' ? 'Adding to BlaakTasks…' : 'Giving it to James…';
}

/** The saved line's first words, before the summary (C4). */
export function savedLabel(target: CaptureTarget): string {
  return target === 'tasks' ? 'Task added' : 'Kept';
}

/** Patch's line when ⌘Z didn't go through: it is still stored. */
export function undoFailedLine(target: CaptureTarget): string {
  return `Couldn’t take it back. It’s still in ${TARGET_NAMES[target]}.`;
}

export interface QuickAskState {
  readonly box: AskState;
  readonly result: QuickAskResult | null;
  /** While choosing: each choice's folder, in the box's order. */
  readonly folders: readonly string[];
  /** Patch's line under the box, after a capture failed (C5). */
  readonly note: string;
}

export const initialQuickAskState: QuickAskState = {
  box: initialAskState, result: null, folders: [], note: '',
};

/** The box's events the pop-up uses as they are. */
type BoxEvent = Extract<RendererEvent, {
  type: 'askTextChanged' | 'askSent' | 'askCancelled' | 'askChoiceStepped' | 'askChoiceHovered' | 'askChoicesClosed'
    | 'askChoicesHandedOff';
}>;

export type QuickAskEvent =
  | BoxEvent
  /** Main answered the send counted as `asked`. */
  | { type: 'quickAskReplied'; asked: number; reply: QuickAskReply }
  /** Enter on a choice: the box waits while main starts it. */
  | { type: 'quickAskChoiceSent' }
  /** The send turned out to be a capture into `target`, and it is being written. */
  | { type: 'quickAskSaving'; target: CaptureTarget }
  /** ⌘Z on the saved line: main takes the capture back. */
  | { type: 'quickAskUndoing' }
  /** Main answered the undo. */
  | { type: 'quickAskUndone'; ok: boolean }
  /** "Undone" has shown: the text goes back in the box. */
  | { type: 'quickAskRestored' }
  /** The pop-up came on screen. */
  | { type: 'quickAskShown' }
  /** The pop-up went away. */
  | { type: 'quickAskClosed' };

export function quickAskPhase(state: QuickAskState): QuickAskPhase {
  return state.result?.kind ?? state.box.phase;
}

/** Esc, a click away and ⌥Space close it, except while it waits, saves or undoes (B4). */
export function canClose(phase: QuickAskPhase): boolean {
  return phase !== 'waiting' && phase !== 'saving' && phase !== 'undoing';
}

export function quickAskReducer(state: QuickAskState, event: QuickAskEvent): QuickAskState {
  switch (event.type) {
    case 'quickAskReplied':
      if (state.box.phase !== 'waiting' || event.asked !== state.box.asked) return state;
      return replied(state, event.reply);

    case 'quickAskChoiceSent': {
      const { box } = state;
      if (box.phase !== 'choosing' || box.choices.length === 0) return state;
      return { ...state, box: { ...closed(box), phase: 'waiting', asked: box.asked + 1 }, folders: [] };
    }

    case 'quickAskSaving':
      return state.box.phase === 'waiting' && !state.result
        ? { ...state, result: { kind: 'saving', target: event.target } }
        : state;

    case 'quickAskUndoing': {
      const { result } = state;
      return result?.kind === 'saved' ? { ...state, result: { ...result, kind: 'undoing' } } : state;
    }

    case 'quickAskUndone': {
      const { result } = state;
      if (result?.kind !== 'undoing') return state;
      return event.ok
        ? { ...state, result: { kind: 'undone', text: result.text } }
        : { ...state, result: null, note: undoFailedLine(result.target) };
    }

    case 'quickAskRestored':
      return state.result?.kind === 'undone' ? restored(state, state.result.text) : state;

    // Back with the draft, to edit; whatever showed last time is over.
    case 'quickAskShown':
    case 'quickAskClosed':
      if (!canClose(quickAskPhase(state))) return state;
      // Closed before "Undone" had gone: the text is back all the same.
      if (state.result?.kind === 'undone') return restored(state, state.result.text);
      if (state.result === null && state.box.phase === 'editing') return state;
      return { ...state, box: closed(state.box), result: null, folders: [] };

    default: {
      const box = askReducer(state.box, event);
      if (box === state.box) return state;
      // Typing again puts Patch's last line away.
      const note = event.type === 'askTextChanged' ? '' : state.note;
      return { ...state, box, note, folders: box.phase === 'choosing' ? state.folders : [] };
    }
  }
}

function replied(state: QuickAskState, reply: QuickAskReply): QuickAskState {
  const editing = { ...state.box, phase: 'editing' as const };
  switch (reply.kind) {
    case 'started':
      return { ...state, box: { ...editing, text: '' }, result: { kind: 'started', folder: reply.folder }, note: '' };
    case 'choose':
      if (reply.candidates.length === 0) return { ...state, box: editing, result: null };
      return {
        ...state,
        box: { ...state.box, phase: 'choosing', choices: reply.candidates.map(c => c.projectPath), selected: 0, prompt: '' },
        folders: reply.candidates.map(c => c.folder),
        result: null,
      };
    // The main window's picker carries the text now; the box keeps it, as the empty screen's does.
    case 'handedOff':
      return { ...state, box: { ...editing, handedOff: true }, result: null };
    case 'saved':
      return {
        ...state, box: { ...editing, text: '' }, note: '',
        result: { kind: 'saved', target: reply.target, summary: reply.summary, text: state.box.text },
      };
    case 'captureFailed':
      return { ...state, box: editing, result: null, note: reply.reason };
    case 'unlocked':
      return { ...state, box: editing, result: null };
  }
}

/** Undone: the text back in the box, to edit. */
function restored(state: QuickAskState, text: string): QuickAskState {
  return { ...state, box: { ...closed(state.box), text }, result: null, note: '' };
}

/** The box back to editing, its list closed. */
function closed(box: AskState): AskState {
  return { ...box, phase: 'editing', choices: [], selected: 0, prompt: '' };
}

/**
 * What a key does in the box on the empty screen, and what Patch says while
 * it is asked (#135): the rules, from the key and the phase alone, so they
 * are tested in node.
 *
 * The focus stays in the box the whole time, through waiting and choosing, so
 * every key the box acts on is heard on it. While it waits or offers its
 * choices it is read-only, which is what keeps the text from being typed over
 * without each key having to be turned away here.
 */
import type { AskOutcome, AskPhase } from '../../state/ask-slice';
import type { PatchBeat } from '../../../domain/companion/patch';

export type AskKey =
  /** Editing: send what is in the box. */
  | 'send'
  /** Waiting: stop asking and unlock the box (W2). */
  | 'cancel'
  /** Choosing: move the highlight. */
  | 'up' | 'down'
  /** Choosing: start a session in the highlighted project. */
  | 'start'
  /** Choosing: open the full New Session picker instead. */
  | 'picker'
  /** Choosing: back to editing the box. */
  | 'close'
  /** A key the box keeps to itself without acting on it. */
  | 'swallow';

export interface AskKeyPress {
  key: string;
  shiftKey: boolean;
  /** Mid-composition (an IME, a dead key): the Enter belongs to the composition. */
  isComposing: boolean;
}

/** Enter sends and Shift+Enter is a new line; the rest only count while waiting or choosing. */
export function askKey(phase: AskPhase, press: AskKeyPress): AskKey | null {
  if (press.isComposing) return null;
  const { key, shiftKey } = press;
  switch (phase) {
    case 'editing':
      return key === 'Enter' && !shiftKey ? 'send' : null;
    case 'waiting':
      if (key === 'Escape') return 'cancel';
      return key === 'Enter' || key === 'Tab' ? 'swallow' : null;
    case 'choosing':
      switch (key) {
        case 'Enter': return shiftKey ? 'swallow' : 'start';
        case 'ArrowUp': return 'up';
        case 'ArrowDown': return 'down';
        // Shift+Tab would take the focus, and the list's keys with it, out of the box.
        case 'Tab': return shiftKey ? 'swallow' : 'picker';
        case 'Escape': return 'close';
        default: return null;
      }
  }
}

/**
 * Cmd+Arrow, which moves the caret to a line's start or end in a text field
 * and steps through the open sessions everywhere else (`app/shortcuts`). In
 * the box it is the caret's: the session step would yank the user off the
 * empty screen mid-sentence.
 */
export function isCaretChord(e: { key: string; metaKey: boolean; altKey: boolean }): boolean {
  if (!e.metaKey || e.altKey) return false;
  return e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown';
}

/**
 * Cmd+A in an empty box: the New Session picker, as it is everywhere outside
 * a text field. The box holds the focus on the empty screen, so without this
 * the app's oldest shortcut would stop working there; once there is text,
 * Cmd+A is Select All again.
 */
export function opensPickerFromBox(
  e: { code: string; metaKey: boolean; altKey: boolean; shiftKey: boolean; ctrlKey: boolean },
  text: string,
): boolean {
  if (!e.metaKey || e.altKey || e.shiftKey || e.ctrlKey || e.code !== 'KeyA') return false;
  return text.trim() === '';
}

// ── What Patch says ──

const THINKING_BEATS: readonly PatchBeat[] = [
  { move: 'peek', line: 'Hmm, let me think…' },
  { move: 'peek', line: 'Which project was that again…' },
  { move: 'peek', line: 'Thinking it over…' },
];

/** Patch while the nth send is being routed (W1); there is no thinking move, so it peeks. */
export function thinkingBeat(n: number): PatchBeat {
  const k = THINKING_BEATS.length;
  return THINKING_BEATS[((Math.trunc(n) % k) + k) % k];
}

/** Patch once the box unlocks after Esc. */
export const CANCELLED_BEAT: PatchBeat = { move: 'jelly', line: 'Okay, never mind.' };

/**
 * Patch's answer to an outcome, or null when it has nothing to add: a sure
 * answer puts the session on screen, and a cancel has its own line.
 */
export function outcomeBeat(outcome: AskOutcome): PatchBeat | null {
  switch (outcome.kind) {
    case 'choose':
      return { move: 'wave', line: 'Not quite sure. One of these?' };
    case 'picker':
      return { move: 'jelly', line: outcome.say };
    case 'start':
    case 'unlock':
      return null;
  }
}

// ── Focus ──

/**
 * Whether the box takes the focus as the empty screen comes into view (B2).
 *
 * Not from an open dialog, which is where the user is typing, and not from
 * the sidebar: the session list holds the focus while its cursor is out
 * (`features/sessions/sidebar-keyboard`), and archiving the session on screen
 * from there shows the empty screen with the user still arrowing through the
 * list. Anywhere else the focus was in a panel that has just been hidden.
 */
export function boxTakesFocus(where: { dialogOpen: boolean; focusInSidebar: boolean }): boolean {
  return !where.dialogOpen && !where.focusInSidebar;
}

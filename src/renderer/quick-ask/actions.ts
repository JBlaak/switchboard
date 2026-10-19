/**
 * What the Quick Ask pop-up does (#142): send the text to main, show what came
 * of it, and close when it is done or the user is.
 *
 * As on the empty screen, the state moves in the reducer and what follows
 * outside it, here a close on a timer, is done only when the reducer took the
 * answer, so the late answer to a cancelled send cannot close anything.
 */
import { dispatch, getState } from './store';
import { canClose, quickAskPhase } from '../state/quick-ask-slice';
import type { QuickAskReply } from '../../ipc/quick-ask-api';

/** How long "Started in ‹folder›" shows before the pop-up closes (B7). */
export const STARTED_MS = 700;
/** How long the saved line shows (C4). */
export const SAVED_MS = 3_000;

let closeTimer: ReturnType<typeof setTimeout> | null = null;

function clearCloseTimer(): void {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = null;
}

export function changeText(text: string): void {
  dispatch({ type: 'askTextChanged', text });
}

/** Enter: main routes the text (R1). */
export async function send(): Promise<void> {
  const before = getState().box;
  dispatch({ type: 'askSent' });
  const sent = getState().box;
  if (sent === before) return;
  await answer(sent.asked, window.quickAsk.route(sent.text));
}

/** Esc while waiting: unlock straight away; main's answer to the cancel is dropped. */
export function cancel(): void {
  if (quickAskPhase(getState()) !== 'waiting') return;
  dispatch({ type: 'askCancelled' });
  void window.quickAsk.cancel();
}

// ── The choice list ──

export function stepChoice(step: 1 | -1): void {
  dispatch({ type: 'askChoiceStepped', step });
}

export function hoverChoice(index: number): void {
  dispatch({ type: 'askChoiceHovered', index });
}

/** Start the choice at `index`, or the highlighted one. */
export async function startChoice(index?: number): Promise<void> {
  if (index !== undefined) hoverChoice(index);
  const { box } = getState();
  const projectPath = box.choices[box.selected];
  if (box.phase !== 'choosing' || projectPath === undefined) return;
  dispatch({ type: 'quickAskChoiceSent' });
  await answer(getState().box.asked, window.quickAsk.start(projectPath));
}

export function closeChoices(): void {
  dispatch({ type: 'askChoicesClosed' });
}

/** Tab: the New Session picker in the main window, carrying the text. */
export function openPicker(): void {
  if (getState().box.phase !== 'choosing') return;
  dispatch({ type: 'askChoicesHandedOff' });
  void window.quickAsk.openPicker();
  close();
}

// ── Showing and closing ──

export function shown(): void {
  clearCloseTimer();
  dispatch({ type: 'quickAskShown' });
}

/** Esc, a click away, ⌥Space: close, keeping the draft, unless it waits or saves (B4). */
export function close(): void {
  if (!canClose(quickAskPhase(getState()))) return;
  clearCloseTimer();
  dispatch({ type: 'quickAskClosed' });
  window.quickAsk.dismiss();
}

async function answer(asked: number, reply: Promise<QuickAskReply>): Promise<void> {
  const settled = await reply
    // Main answers rather than rejecting; this is for the IPC itself giving way.
    .catch((): QuickAskReply => ({ kind: 'unlocked' }));
  const waiting = getState();
  dispatch({ type: 'quickAskReplied', asked, reply: settled });
  if (getState() === waiting) return;
  switch (settled.kind) {
    case 'started':
      closeAfter(STARTED_MS);
      return;
    case 'saved':
      closeAfter(SAVED_MS);
      return;
    case 'handedOff':
      close();
      return;
    case 'choose':
    case 'captureFailed':
    case 'unlocked':
      return;
  }
}

function closeAfter(ms: number): void {
  clearCloseTimer();
  closeTimer = setTimeout(() => { closeTimer = null; close(); }, ms);
}

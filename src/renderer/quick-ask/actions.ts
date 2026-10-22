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
import { slabMotion } from './motion';
import type { CaptureTarget, QuickAskLooks, QuickAskReply } from '../../ipc/quick-ask-api';

/** How long "Started in ‹folder›" shows before the pop-up closes (B7). */
export const STARTED_MS = 700;
/** How long the saved line shows (C4). */
export const SAVED_MS = 3_000;
/** How long "Undone" shows before the text is back in the box (C4). */
export const UNDONE_MS = 700;

let closeTimer: ReturnType<typeof setTimeout> | null = null;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

function clearCloseTimer(): void {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = null;
}

function clearRestoreTimer(): void {
  if (restoreTimer !== null) clearTimeout(restoreTimer);
  restoreTimer = null;
}

export function changeText(text: string): void {
  dispatch({ type: 'askTextChanged', text });
}

/** Enter: main routes the text (R1). */
export async function send(): Promise<void> {
  await sendBy(text => window.quickAsk.route(text));
}

/** ⌘Enter: main starts a quick session on the text as typed, without routing it. */
export async function sendQuick(): Promise<void> {
  await sendBy(text => window.quickAsk.quick(text));
}

async function sendBy(ask: (text: string) => Promise<QuickAskReply>): Promise<void> {
  const before = getState().box;
  dispatch({ type: 'askSent' });
  const sent = getState().box;
  if (sent === before) return;
  await answer(sent.asked, ask(sent.text));
}

/** Esc while waiting: unlock straight away; main's answer to the cancel is dropped. */
export function cancel(): void {
  if (quickAskPhase(getState()) !== 'waiting') return;
  dispatch({ type: 'askCancelled' });
  void window.quickAsk.cancel();
}

// ── Captures ──

/** Main says the send is a capture into `target`, being written now. */
export function saving(target: CaptureTarget): void {
  dispatch({ type: 'quickAskSaving', target });
}

/** ⌘Z on the saved line: the 3 s stop, main takes it back, and "Undone" gives way to the text. */
export async function undo(): Promise<void> {
  const before = getState();
  dispatch({ type: 'quickAskUndoing' });
  if (getState() === before) return;
  clearCloseTimer();
  const { ok } = await window.quickAsk.undo()
    .catch(() => ({ ok: false }));
  const undoing = getState();
  dispatch({ type: 'quickAskUndone', ok });
  if (!ok || getState() === undoing) return;
  slabMotion.pulse();
  clearRestoreTimer();
  restoreTimer = setTimeout(() => { restoreTimer = null; dispatch({ type: 'quickAskRestored' }); }, UNDONE_MS);
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

/** On screen: the system's settings, as they are now, for this open; then it grows from the drop. */
export function shown(looks?: QuickAskLooks): void {
  clearCloseTimer();
  clearRestoreTimer();
  if (looks) applyLooks(looks);
  dispatch({ type: 'quickAskShown' });
  slabMotion.open();
}

/** Esc, a click away, ⌥Space: close, keeping the draft, unless it waits or saves (B4). */
export function close(): void {
  if (!canClose(quickAskPhase(getState()))) return;
  clearCloseTimer();
  clearRestoreTimer();
  dispatch({ type: 'quickAskClosed' });
  // The window goes once the slab has gone back into the drop.
  slabMotion.close(() => window.quickAsk.dismiss());
}

/** ⌥Space while showing (H1): close, or, caught mid-close, come back from where it got to. */
export function toggle(): void {
  if (slabMotion.closing) shown();
  else close();
}

function applyLooks(looks: QuickAskLooks): void {
  const reduceMotion = looks.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduceTransparency = looks.reduceTransparency || matchMedia('(prefers-reduced-transparency: reduce)').matches;
  slabMotion.setMode(window.switchboardE2E ? 'instant' : reduceMotion ? 'reduced' : 'full');
  const root = document.documentElement;
  root.toggleAttribute('data-reduce-motion', reduceMotion);
  root.toggleAttribute('data-reduce-transparency', reduceTransparency);
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
      slabMotion.pulse();
      closeAfter(STARTED_MS);
      return;
    case 'saved':
      slabMotion.pulse();
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

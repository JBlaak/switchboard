/**
 * What a key on the question panel means, from the key alone and where it
 * landed.
 *
 * Unmodified keys stop at the panel — none of them is the terminal's or a
 * global shortcut's to have (a bare N would otherwise start a quick session);
 * Cmd/Ctrl/Alt combinations, Tab and keys mid IME composition go on to the
 * app. The panel's listener applies the answer; whether the panel can act at
 * that moment (up, not mid-swap, not sending) is its own to check.
 */
import type { DraftAction } from '../../../domain/questions/answer-draft';

export interface PanelKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

export interface PanelKeyPlace {
  /** The key landed in the Other field. */
  inOther: boolean;
  /** The key landed on Patch, which is a button. */
  onPatch: boolean;
  /** How many options the question on screen has (the Other row comes after). */
  options: number;
}

export type PanelKey =
  /** Not the panel's: it goes on to the app. */
  | { does: 'pass' }
  /** Stops at the panel, but its default is left alone (typing, a button's click). */
  | { does: 'keep' }
  /** Answer in the terminal instead. */
  | { does: 'terminal' }
  | { does: 'act'; action: DraftAction };

const PASS: PanelKey = { does: 'pass' };
const KEEP: PanelKey = { does: 'keep' };
const act = (action: DraftAction): PanelKey => ({ does: 'act', action });

export function panelKey(e: PanelKeyEvent, at: PanelKeyPlace): PanelKey {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return PASS;
  if (e.key === 'Tab') return PASS;
  // Enter and Space on Patch poke it, as a button should.
  if ((e.key === 'Enter' || e.key === ' ') && at.onPatch) return KEEP;

  switch (e.key) {
    case 'ArrowDown': return act({ kind: 'move', by: 1 });
    case 'ArrowUp': return act({ kind: 'move', by: -1 });
    case 'Enter': return act({ kind: 'next' });
    case 'Escape': return { does: 'terminal' };
  }
  // Typing an answer of one's own: numbers, space and ←/→ are the text's.
  if (at.inOther) return KEEP;

  if (/^[1-9]$/.test(e.key) && Number(e.key) <= at.options + 1) return act({ kind: 'press', row: Number(e.key) - 1 });
  if (e.key === ' ') return act({ kind: 'space' });
  if (e.key === 'ArrowLeft') return act({ kind: 'back' });
  if (e.key === 'ArrowRight') return act({ kind: 'next' });
  return KEEP;
}

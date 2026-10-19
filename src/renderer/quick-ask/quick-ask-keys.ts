/**
 * What a key does in the Quick Ask pop-up (B3), and where the pointer is: the
 * rules, from the key, the phase and the slab's rectangle alone, so they are
 * tested in node.
 *
 * The box's keys are the empty screen's (`ask-keys`). The pop-up adds Esc to
 * close it while editing, and keeps every key to itself while a result shows.
 */
import { askKey } from '../ui/ask/ask-keys';
import type { AskKey, AskKeyPress } from '../ui/ask/ask-keys';
import type { QuickAskPhase } from '../state/quick-ask-slice';

export type QuickAskKey = AskKey | 'dismiss';

export function quickAskKey(phase: QuickAskPhase, press: AskKeyPress): QuickAskKey | null {
  if (press.isComposing) return null;
  switch (phase) {
    case 'editing':
      return press.key === 'Escape' ? 'dismiss' : askKey(phase, press);
    case 'waiting':
    case 'choosing':
      return askKey(phase, press);
    // A capture half-written is not cancelled from here (B4).
    case 'saving':
      return press.key === 'Escape' || press.key === 'Enter' || press.key === 'Tab' ? 'swallow' : null;
    case 'started':
    case 'saved':
      return press.key === 'Escape' ? 'dismiss' : 'swallow';
  }
}

export interface Rect { left: number; top: number; width: number; height: number }

/** Whether the pointer at (`x`, `y`) is over the slab, whose box is `rect`; both in the page's pixels. */
export function overSlab(x: number, y: number, rect: Rect): boolean {
  return x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
}

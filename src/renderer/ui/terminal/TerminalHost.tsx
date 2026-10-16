/**
 * The terminals: one slot per open session, inside `#terminals`.
 *
 * Slots are keyed by their own id rather than the session's, so a re-key
 * keeps the same container (and terminal) on screen, while a relaunch — the
 * old terminal torn down, a new one built under the same session id — gets a
 * fresh one instead of inheriting the old one's leftovers.
 */
import type { JSX } from 'react';
import { useStore } from '../use-store';
import { TerminalSlot } from './TerminalSlot';

export function TerminalHost(): JSX.Element {
  const slots = useStore(state => state.terminal.slots);
  const onScreen = useStore(state => state.terminal.onScreen);
  return (
    <>
      {slots.map(slot => (
        <TerminalSlot key={slot.slotId} sessionId={slot.sessionId} visible={slot.sessionId === onScreen} />
      ))}
    </>
  );
}

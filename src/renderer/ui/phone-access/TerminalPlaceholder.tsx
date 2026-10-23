/**
 * "Active on Pixel 9 Pro" (#194), in place of a terminal a phone has.
 *
 * It covers the session's xterm inside its slot rather than replacing it: the
 * terminal stays mounted and keeps its buffer, and the terminal manager drops
 * its keys and resizes while a phone has it, so this takes no input. Use here
 * asks main for the session back; the terminal is refitted when it returns
 * (`install-phone-access`).
 */
import { deviceOwnerIn } from '../../state/phone-access-slice';
import { useStore } from '../use-store';
import { useTerminalHere } from './actions';
import { PhoneIcon } from './icons';
import { failureLine, placeholderCopy } from './phone-access-copy';
import { useNow } from './use-now';
import type { JSX } from 'react';

export function TerminalPlaceholder({ sessionId }: { sessionId: string }): JSX.Element | null {
  const owner = useStore(s => deviceOwnerIn(s.phoneAccess, sessionId));
  const access = useStore(s => s.phoneAccess.access);
  const failure = useStore(s => (s.phoneAccess.failure?.call === 'useHere' ? s.phoneAccess.failure : null));
  const now = useNow(30_000, !!owner);
  if (!owner) return null;

  const copy = placeholderCopy(owner, access, now);
  return (
    <div className="pa-placeholder" data-testid="terminal-placeholder">
      <span className="pa-placeholder-icon"><PhoneIcon size={48} strokeWidth={1.3} /></span>
      <div className="pa-placeholder-text">
        <h2 className="pa-placeholder-title">{copy.title}</h2>
        <p className="pa-placeholder-body">{copy.body}</p>
      </div>
      <button type="button" className="pa-use-here" onClick={() => void useTerminalHere(sessionId)}>Use here</button>
      {failure && <span className="pa-error" role="alert">{failureLine(failure)}</span>}
      {copy.note && <span className="pa-placeholder-note">{copy.note}</span>}
    </div>
  );
}

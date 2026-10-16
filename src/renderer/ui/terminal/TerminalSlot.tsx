/**
 * One session's terminal container.
 *
 * React owns the element and whether it is the one on screen; the terminal
 * manager owns everything inside it. When the element mounts, the manager
 * opens the session's xterm into it (`attachTerminal`), and from then on the
 * output, the input and the fitting never pass through React.
 *
 * A hidden slot stays mounted — `.visible` comes and goes, the element does
 * not — so a terminal keeps its buffer, its scroll position and its WebGL
 * context while another session is on screen. And `visible` is toggled on the
 * class list rather than rendered into `className`: other code puts classes of
 * its own on this element (`qp-under` from the question panel, `drag-over`
 * from the drop handler) that a re-render must not wipe.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';
import type { JSX } from 'react';
import { attachTerminal } from '../../features/terminal/terminal-manager';
import { RemoteCard } from '../remote/RemoteCard';
import { TerminalSearchBar } from './TerminalSearchBar';

export interface TerminalSlotProps {
  sessionId: string;
  visible: boolean;
}

export function TerminalSlot({ sessionId, visible }: TerminalSlotProps): JSX.Element {
  const element = useRef<HTMLDivElement | null>(null);
  // The id the slot was created for. A re-key keeps the slot and its
  // terminal, so later ids never need attaching.
  const createdFor = useRef(sessionId);

  // Stable, so React calls it once on mount rather than on every render.
  // attachTerminal is idempotent, which keeps StrictMode's extra call harmless.
  const attach = useCallback((el: HTMLDivElement | null) => {
    element.current = el;
    if (el) attachTerminal(createdFor.current, el);
  }, []);

  useLayoutEffect(() => {
    element.current?.classList.toggle('visible', visible);
  }, [visible]);

  return (
    <div className="terminal-container" ref={attach}>
      <TerminalSearchBar sessionId={sessionId} />
      <RemoteCard sessionId={sessionId} />
    </div>
  );
}

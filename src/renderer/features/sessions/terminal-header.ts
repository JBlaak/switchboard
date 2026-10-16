/**
 * What the modules outside React say to the terminal header.
 *
 * The header itself is React (`ui/terminal/TerminalHeader`), drawn from the
 * store. These name the events the poller, the connection log and the IPC
 * follow-ups send it, and the name it gives a session.
 */
import { cleanDisplayName } from '../../../domain/session/title';
import { dispatch } from '../../state/app-store';
import type { SessionRow } from '../../../domain/session/session';

/** What the header calls a session. */
export function headerNameFor(session: SessionRow): string {
  return cleanDisplayName(session.name || session.aiTitle || session.summary) ?? '';
}

/**
 * Repaint the header.
 *
 * Its running state, connection label and title already follow the store; what
 * a repaint still does is put the process title back where a CLI notice was —
 * which is why the poller and the connection card keep calling this.
 */
export function updateTerminalHeader(): void {
  dispatch({ type: 'headerRefreshed' });
}

/**
 * Name the header for a session, from its row.
 *
 * From the row rather than from the sidebar's DOM, so a re-key can name the
 * header before (and whether or not) the row has been redrawn.
 */
export function setHeaderIdentity(session: SessionRow): void {
  dispatch({ type: 'headerRenamed', sessionId: session.sessionId, name: headerNameFor(session) });
}

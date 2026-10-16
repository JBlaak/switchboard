/**
 * Starting a rename from vanilla code: the keyboard's R and F2.
 *
 * The rename itself is React (`ui/session-list/RenameInput`); this stays as
 * the entry point `sidebar-keyboard` already imports, until it moves too.
 *
 * Committed at once rather than on the next render: the keyboard listens on
 * the input for the Enter or Escape that ends the rename, so the input has to
 * be in the DOM when this returns.
 */
import { flushSync } from 'react-dom';
import { dispatch, getState } from '../../state/app-store';
import { sessionKeyIn } from '../../state/keys-slice';
import { rowId } from '../../state/session-list-layout';
import type { SessionRow } from '../../../domain/session/session';

export function startRename(_summary: HTMLElement, session: SessionRow): void {
  const id = rowId(sessionKeyIn(getState().keys, session.sessionId));
  flushSync(() => dispatch({ type: 'renameStarted', rowId: id }));
}

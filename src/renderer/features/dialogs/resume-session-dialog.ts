/**
 * Opening "Resume with config" from vanilla code.
 *
 * The dialog itself is React (`ui/dialogs/ResumeSessionDialog`); this stays as
 * the entry point a session row's action already imports, until it moves too.
 */
import { openResumeDialog } from '../../ui/dialogs/actions';
import type { SessionRow } from '../../../domain/session/session';

export function showResumeSessionDialog(session: SessionRow): Promise<void> {
  return openResumeDialog(session);
}

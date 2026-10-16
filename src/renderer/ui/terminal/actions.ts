/**
 * What the terminal header does beyond drawing itself: look up the shell a
 * session runs in, and stop the session on screen.
 */
import { dispatch, getState } from '../../state/app-store';
import { confirmAndStopSession } from '../../features/sessions/session-actions';
import type { SessionRow } from '../../../domain/session/session';

/**
 * Find out which shell profile a session runs in, for the header.
 *
 * Only a profile other than the default gets a name: naming the shell on
 * every session would be noise, but a session deliberately running in a
 * different one is worth being able to see. A failed lookup counts as the
 * default.
 *
 * The answer is filed under the session it is for, so a slow lookup cannot
 * name the shell of a session the user has since switched away from.
 */
export async function loadShellProfile(session: SessionRow): Promise<void> {
  let name: string | null = null;
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId !== 'auto') {
      const profiles = await window.api.getShellProfiles();
      name = profiles.find(p => p.id === profileId)?.name ?? profileId;
    }
  } catch {
    name = null;
  }
  // The row's id as of now: a re-key renames the shared row in place.
  dispatch({ type: 'shellProfileResolved', sessionId: session.sessionId, name });
}

/** The header's Stop button: stop the session on screen, after asking. */
export function stopSessionOnScreen(): void {
  const { activeSessionId } = getState().view;
  if (activeSessionId) void confirmAndStopSession(activeSessionId);
}

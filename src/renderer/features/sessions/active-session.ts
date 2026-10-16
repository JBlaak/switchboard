/**
 * Which session is on screen.
 *
 * Persisted so a reload lands back where the user was.
 */
import { dispatch } from '../../state/app-store';
import { STORAGE_KEYS, writeStored } from '../../state/session-store';

export function setActiveSession(sessionId: string | null): void {
  dispatch({ type: 'activeSessionChanged', sessionId });
  writeStored('sessionStorage', STORAGE_KEYS.activeSessionId, sessionId);
}

/**
 * Which session is on screen.
 *
 * Persisted so a reload lands back where the user was, and broadcast to the
 * side panel, whose open files and diffs are per-session.
 */
import { STORAGE_KEYS, view, writeStored } from '../../state/session-store';
import { switchPanel } from '../panel/file-panel';

export function setActiveSession(sessionId: string | null): void {
  view.activeSessionId = sessionId;
  writeStored('sessionStorage', STORAGE_KEYS.activeSessionId, sessionId);
  switchPanel(sessionId);
}

/** Persist which slug groups are open, so a reload does not collapse them all. */
export function getExpandedSlugs(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.expandedSlugs) || '[]') as string[]);
  } catch {
    return new Set();
  }
}

export function saveExpandedSlugs(): void {
  const expanded: string[] = [];
  document.querySelectorAll<HTMLElement>('.slug-group:not(.collapsed)')
    .forEach(group => { if (group.id) expanded.push(group.id); });
  writeStored('sessionStorage', STORAGE_KEYS.expandedSlugs, JSON.stringify(expanded));
}

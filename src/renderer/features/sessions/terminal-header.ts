/**
 * The bar above the terminal: which session, whether it is running, and what
 * the process last called itself.
 */
import { cleanDisplayName } from '../../../domain/session/title';
import { remoteStatusLabel } from '../../../domain/remote/remote-status';
import { remoteStatus } from '../../state/remote-status-store';
import { openSessions, view } from '../../state/session-store';
import { el, terminalHeader } from '../../lib/dom';
import type { SessionRow } from '../../../domain/session/session';

const headerName = el('terminal-header-name');
const headerId = el('terminal-header-id');
const headerStatus = el('terminal-header-status');
const headerShell = el('terminal-header-shell');
const headerPtyTitle = el('terminal-header-pty-title');
const stopButton = el('terminal-stop-btn');

export { stopButton as terminalStopButton };

/** Show the header for a session, and fill in which shell it is running in. */
export async function showTerminalHeader(session: SessionRow): Promise<void> {
  headerName.textContent = cleanDisplayName(session.name || session.aiTitle || session.summary) ?? '';
  headerId.textContent = session.sessionId;
  terminalHeader.style.display = '';
  updateTerminalHeader();

  // Only shown when it is not the default: naming the shell on every session
  // would be noise, but a session deliberately running in a different one is
  // worth being able to see.
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId === 'auto') {
      headerShell.style.display = 'none';
      return;
    }
    const profiles = await window.api.getShellProfiles();
    headerShell.textContent = profiles.find(p => p.id === profileId)?.name ?? profileId;
    headerShell.style.display = '';
  } catch {
    headerShell.style.display = 'none';
  }
}

/**
 * Repaint the running/stopped label.
 *
 * A remote session mid-connect is neither running nor stopped, and saying
 * either is misleading — so a connection label takes precedence when there is
 * one.
 */
export function updateTerminalHeader(): void {
  if (!view.activeSessionId) return;

  const running = view.activePtyIds.has(view.activeSessionId);
  const connecting = remoteStatusLabel(remoteStatus.get(view.activeSessionId));

  if (connecting) {
    headerStatus.className = 'connecting';
    headerStatus.textContent = connecting;
  } else {
    headerStatus.className = running ? 'running' : 'stopped';
    headerStatus.textContent = running ? 'Running' : 'Stopped';
  }

  stopButton.style.display = running ? '' : 'none';
  updatePtyTitle();
}

/** The title the process set for itself, shown next to the session name. */
export function updatePtyTitle(): void {
  if (!view.activeSessionId) return;
  const title = openSessions.get(view.activeSessionId)?.ptyTitle || '';
  headerPtyTitle.textContent = title;
  headerPtyTitle.style.display = title ? '' : 'none';
}

/** Show a message from the CLI in the header, in place of the process title. */
export function showHeaderNotice(message: string): void {
  headerPtyTitle.textContent = message;
  headerPtyTitle.style.display = '';
}

/** Rename the header, for a session that has just been re-keyed. */
export function setHeaderIdentity(sessionId: string, name?: string | null): void {
  headerId.textContent = sessionId;
  if (name !== undefined) headerName.textContent = name ?? '';
}

/** Hide the header — nothing is on screen. */
export function hideTerminalHeader(): void {
  terminalHeader.style.display = 'none';
}

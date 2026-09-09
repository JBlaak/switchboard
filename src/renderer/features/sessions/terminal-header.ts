/**
 * The bar above the terminal: which session, whether it is running, what the
 * process last called itself, and which half of the window it has.
 */
import { cleanDisplayName } from '../../../domain/session/title';
import { remoteStatusLabel } from '../../../domain/remote/remote-status';
import { remoteStatus } from '../../state/remote-status-store';
import { openSessions, view } from '../../state/session-store';
import { el, terminalHeader } from '../../lib/dom';
import { shortcutLabel } from '../../lib/format';
import { MAIN_MODES } from '../../app/main-mode-model';
import type { MainMode } from '../../app/main-mode-model';
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

// ── Talk | Split | Code ─────────────────────────────────────────────────────

/** The three buttons, by the mode each one asks for. */
const modeButtons = new Map<MainMode, HTMLButtonElement>();

/** How each mode reads to someone who has not used ⌘J yet. */
const MODE_HINTS: Record<MainMode, string> = {
  talk: `The conversation, full width (${shortcutLabel('J')})`,
  split: 'The conversation with the side panel out',
  code: `The code, full width (${shortcutLabel('J')})`,
};

/**
 * Build the mode control.
 *
 * The flip hands its setter in and calls `paintModeControl` when the mode
 * moves, rather than this module importing `app/main-mode`. That direction is
 * deliberate: the flip already reaches the terminal manager and the tab router,
 * and an import back from a header the terminal manager itself imports would
 * close a loop across most of the renderer. The header stays a leaf.
 *
 * The control names the three states the gesture moves between, which is the
 * whole reason it exists — ⌘J is unguessable on its own, and a segmented
 * control that is also the shortcut's label makes it findable. `Split` is only
 * reachable here, because it is the state ⌘J deliberately does not stop on.
 */
export function installModeControl(pick: (mode: MainMode) => void): void {
  if (modeButtons.size > 0) return;
  const controls = el('terminal-header-controls');

  const group = document.createElement('div');
  group.id = 'terminal-header-mode';
  group.className = 'sb-segmented';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Which half owns the window');

  for (const mode of MAIN_MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sb-segment';
    button.dataset.mode = mode;
    button.textContent = mode[0].toUpperCase() + mode.slice(1);
    button.title = MODE_HINTS[mode];
    button.addEventListener('click', () => pick(mode));
    group.appendChild(button);
    modeButtons.set(mode, button);
  }
  controls.appendChild(group);

  const hint = document.createElement('span');
  hint.id = 'terminal-header-flip-hint';
  hint.textContent = shortcutLabel('J');
  hint.title = 'Swap the conversation and the code';
  controls.appendChild(hint);
}

/**
 * Show which half currently owns the window.
 *
 * Reflecting rather than remembering: the flip owns the mode, and being told it
 * on every application — not only on a change — is what stops the control and
 * the window disagreeing after a session switch has restored a different one.
 */
export function paintModeControl(mode: MainMode): void {
  for (const [name, button] of modeButtons) {
    button.classList.toggle('on', name === mode);
    button.setAttribute('aria-pressed', String(name === mode));
  }
}

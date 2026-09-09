/**
 * The things a user does to a session: open it, start a new one, stop it,
 * archive it.
 *
 * Each of these has an order that matters — a row is only hidden once nothing
 * is running under it, a new row appears before the CLI has written anything —
 * so they live together rather than being inlined at each of the several places
 * that trigger them.
 */
import { encodeProjectPath } from '../../../domain/project/project-path';
import { sessionExitedBanner } from '../../../domain/terminal/ansi';
import { refreshSidebar, reloadProjects } from '../../app/refresh';
import { resolveDefaultSessionOptions } from '../dialogs/launch-options';
import { setActiveSession } from './active-session';
import { projectLabel } from './project-label';
import { pollActiveSessions } from './session-poller';
import { hideTerminalHeader } from './terminal-header';
import {
  injectIntoCaches, openSessions, pendingSessions, removeFromCaches, sessionMap, view,
} from '../../state/session-store';
import { placeholder } from '../../lib/dom';
import { createTerminalEntry, destroySession, showSession } from '../terminal/terminal-manager';
import { setSessionMcpActive } from '../panel/file-panel';
import { updateGridCount } from '../terminal/grid-view';
import type { Project } from '../../../domain/project/project';
import type { SessionRow } from '../../../domain/session/session';
import type { SessionOptions } from '../../../domain/launch/session-options';

/** A row for a session that has not been written to disk yet. */
export function newSessionRow(projectPath: string, fields: Partial<SessionRow> = {}): SessionRow {
  const now = new Date().toISOString();
  return {
    sessionId: crypto.randomUUID(),
    summary: 'New session',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: now,
    created: now,
    ...fields,
  };
}

/**
 * Register a session the renderer invented, so it has a row to look at.
 *
 * Pending until the project list comes back carrying a real one — see
 * `isPendingAbandoned` for what happens when it never does.
 */
function trackPending(session: SessionRow, remote = false): void {
  const folder = encodeProjectPath(session.projectPath);
  pendingSessions.set(session.sessionId, { session, projectPath: session.projectPath, folder });
  injectIntoCaches(session, folder, remote);
  refreshSidebar();
}

/**
 * Start a Claude session and put it on screen.
 *
 * The terminal is created before the request goes out, so an error has
 * somewhere to be printed — which is the only place a failed pre-launch command
 * is visible.
 */
export async function launchNewSession(project: Project, options?: SessionOptions): Promise<void> {
  const session = newSessionRow(project.projectPath);
  trackPending(session);
  await spawn(session, { isNew: true, options });
}

/**
 * Start a plain terminal.
 *
 * Deliberately not a Claude session: no MCP bridge, no transcript, and it is
 * torn down when its shell exits rather than kept around to read.
 */
export async function launchTerminalSession(project: Project): Promise<void> {
  const session = newSessionRow(project.projectPath, { summary: 'Terminal', type: 'terminal' });
  trackPending(session);
  await spawn(session, { isNew: true, options: { type: 'terminal' } });
}

/**
 * Start a session on a remote project.
 *
 * The main process records it in settings and connects ssh to a fresh tmux
 * session; unlike a plain terminal the sidebar row persists, so after a
 * disconnect — or an app restart — clicking it re-attaches to the session still
 * running on the far end.
 */
export async function launchRemoteSession(project: Project, kind: 'claude' | 'shell'): Promise<void> {
  const session = newSessionRow(project.projectPath, {
    summary: kind === 'shell' ? 'Remote terminal' : 'Remote Claude',
    type: 'remote',
    remoteKind: kind,
  });
  trackPending(session, true);
  await spawn(session, { isNew: true, options: { type: 'remote', remoteKind: kind } });
}

/** Open an existing session, or bring it forward if it is already open. */
export async function openSession(session: SessionRow, options?: SessionOptions): Promise<void> {
  const existing = openSessions.get(session.sessionId);
  if (existing) {
    if (!existing.closed) {
      showSession(session.sessionId);
      return;
    }
    // A closed terminal is a corpse with an exit banner in it; relaunching
    // means starting over, so it goes first.
    destroySession(session.sessionId);
    if (session.type === 'terminal') {
      await launchTerminalSession(projectStub(session.projectPath));
      return;
    }
  }

  // Remote sessions ignore local launch options — the main process reconnects
  // from its stored session record.
  const resumeOptions: SessionOptions = session.type === 'remote'
    ? { type: 'remote', remoteKind: session.remoteKind }
    : options ?? await resolveDefaultSessionOptions(session.projectPath);

  await spawn(session, { isNew: false, options: resumeOptions });
}

/** Create the terminal, ask main to start the process, and show the result. */
async function spawn(
  session: SessionRow,
  { isNew, options }: { isNew: boolean; options?: SessionOptions },
): Promise<void> {
  const entry = createTerminalEntry(session);

  const result = await window.api.openTerminal(
    session.sessionId, session.projectPath, isNew, options ?? undefined);

  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }

  setSessionMcpActive(session.sessionId, !!result.mcpActive);
  showSession(session.sessionId);
  void pollActiveSessions();
}

/** Stop a session, after asking — it is destructive and cannot be undone. */
export async function confirmAndStopSession(sessionId: string): Promise<void> {
  const isRemote = sessionMap.get(sessionId)?.type === 'remote';
  const prompt = isRemote
    ? 'Disconnect? The session keeps running on the remote machine.'
    : 'Stop this session?';
  if (!confirm(prompt)) return;

  await window.api.stopSession(sessionId);
  view.activePtyIds.delete(sessionId);
  if (!view.gridViewActive && view.activeSessionId === sessionId) clearScreen();
  refreshSidebar();
}

/**
 * Archive a session, or bring it back.
 *
 * Archiving is also how a row gets forgotten, so it has to stop the process
 * first and only hide the row once nothing is running under it. Answers false
 * when the stop failed, so the caller leaves the row where it is rather than
 * orphaning a live PTY behind a hidden row.
 *
 * The three call sites — a row, a slug group, a whole project — all come
 * through here, so none of them can drift back into hiding a live session.
 */
export async function archiveSessionRow(session: SessionRow, archived: number): Promise<boolean> {
  const { sessionId } = session;

  if (archived) {
    // Stop unconditionally: `activePtyIds` can lag the real state by up to the
    // idle poll interval, and stopping a dead session is a no-op.
    const result = await window.api.stopSession(sessionId);
    if (result && result.ok === false) {
      alert(`Could not stop this session: ${result.error || 'unknown error'}`);
      return false;
    }
    view.activePtyIds.delete(sessionId);
  }

  await window.api.archiveSession(sessionId, Boolean(archived));
  session.archived = archived;

  // A pending row has no transcript to resume from, so archiving it means
  // forgetting it — and leaving the pending entry behind would re-inject the
  // row on the next refresh with its own `archived: 0`.
  if (archived && pendingSessions.has(sessionId)) dropPendingSession(sessionId);
  return true;
}

/**
 * Archive every unarchived session in a project, after asking with the count.
 *
 * Each row goes through `archiveSessionRow`, so a live session is stopped before
 * its row is hidden. `onDone` runs once the sweep is over and the projects have
 * been re-fetched — the project picker passes its own redraw, since the sidebar
 * refresh does not reach a dialog's list.
 */
export async function archiveAllSessions(project: Project, onDone?: () => void): Promise<void> {
  const sessions = project.sessions.filter(s => !s.archived);
  if (sessions.length === 0) return;

  const plural = sessions.length > 1 ? 's' : '';
  if (!confirm(`Archive all ${sessions.length} session${plural} in ${projectLabel(project.projectPath)}?`)) return;

  for (const session of sessions) {
    // One failure stops the sweep rather than silently skipping a session whose
    // PTY is still running.
    if (!await archiveSessionRow(session, 1)) break;
  }

  void pollActiveSessions();
  await reloadProjects();
  onDone?.();
}

/**
 * Forget a row the renderer invented and nothing ever came of.
 *
 * Takes its terminal with it, so a header still naming that pane would be
 * pointing at nothing.
 */
export function dropPendingSession(sessionId: string): void {
  pendingSessions.delete(sessionId);
  sessionMap.delete(sessionId);
  removeFromCaches(sessionId);
  if (openSessions.has(sessionId)) destroySession(sessionId);

  if (view.gridViewActive) {
    updateGridCount();
  } else if (view.activeSessionId === sessionId) {
    clearScreen();
  }
}

/** Nothing is on screen: hide the terminal chrome and show the placeholder. */
export function clearScreen(): void {
  setActiveSession(null);
  hideTerminalHeader();
  placeholder.style.display = '';
}

/** Write the exit banner into a terminal whose process has ended. */
export function writeExitBanner(sessionId: string, exitCode: number): void {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  entry.closed = true;
  try {
    entry.terminal.write(sessionExitedBanner(exitCode));
  } catch {
    // The terminal was disposed between the exit event and this write.
  }
}

/**
 * A stand-in project for the call sites that only have a path.
 *
 * The launchers read nothing but `projectPath`; building the rest would be
 * inventing data.
 */
export function projectStub(projectPath: string): Project {
  return { projectPath, folder: encodeProjectPath(projectPath), sessions: [] };
}

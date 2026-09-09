/**
 * Wiring up a freshly rendered session list.
 *
 * Handlers are assigned (`onclick =`) rather than added, and re-assigned after
 * every render — the list is morphed in place, so an element can survive a
 * redraw carrying a handler that closes over a stale row. Assignment makes that
 * idempotent; `addEventListener` would stack duplicates.
 */
import { refreshSidebar, reloadProjects } from '../../app/refresh';
import { clearUnread, isUnread, markUnread } from '../../state/activity-store';
import { projectOf, sessionMap, view } from '../../state/session-store';
import { sidebarContent } from '../../lib/dom';
import { showJsonlViewer } from '../jsonl/jsonl-viewer';
import { showResumeSessionDialog } from '../dialogs/resume-session-dialog';
import { forkSession } from '../dialogs/fork-session';
import { saveExpandedSlugs } from './active-session';
import { archiveSessionRow, confirmAndStopSession, openSession } from './session-actions';
import { pollActiveSessions } from './session-poller';
import { startRename } from './session-rename';
import type { SessionRow } from '../../../domain/session/session';

export function bindSidebarEvents(): void {
  bindSlugGroups();
  bindOlderToggles();
  bindSessionRows();
  expandGroupHoldingActiveSession();
}

function bindSlugGroups(): void {
  sidebarContent.querySelectorAll<HTMLElement>('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector<HTMLElement>('.slug-group-archive-btn');
    if (archiveBtn) archiveBtn.onclick = (e) => {
      e.stopPropagation();
      void archiveGroup(header);
    };

    header.onclick = (e) => {
      if ((e.target as HTMLElement).closest('.slug-group-archive-btn')) return;
      header.parentElement?.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  // "+ N more" inside a group: expanding the group is what reveals them.
  sidebarContent.querySelectorAll<HTMLElement>('.slug-group-more').forEach(more => {
    more.onclick = () => {
      more.closest('.slug-group')?.classList.remove('collapsed');
      saveExpandedSlugs();
    };
  });
}

/** Archive every unarchived session in one slug group. */
async function archiveGroup(header: HTMLElement): Promise<void> {
  const group = header.parentElement;
  if (!group) return;

  for (const item of group.querySelectorAll<HTMLElement>('.session-item')) {
    const sessionId = item.dataset.sessionId;
    const session = sessionId ? sessionMap.get(sessionId) : undefined;
    if (!session || session.archived) continue;
    // One failure stops the sweep rather than silently skipping a session whose
    // PTY is still running.
    if (!await archiveSessionRow(session, 1)) break;
  }

  void pollActiveSessions();
  void reloadProjects();
}

/** The list-level "+ N older" toggle, which is purely a show/hide. */
function bindOlderToggles(): void {
  sidebarContent.querySelectorAll<HTMLElement>('.sessions-more-toggle').forEach(toggle => {
    const olderList = toggle.nextElementSibling as HTMLElement | null;
    if (!olderList?.classList.contains('sessions-older')) return;
    const count = olderList.children.length;

    toggle.onclick = () => {
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      toggle.classList.toggle('expanded', !showing);
      toggle.textContent = showing ? `+ ${count} older` : '- hide older';
    };
  });
}

function bindSessionRows(): void {
  sidebarContent.querySelectorAll<HTMLElement>('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionId ? sessionMap.get(sessionId) : undefined;
    if (!session) return;

    item.onclick = () => void openSession(session);

    onAction(item, '.session-pin', async () => {
      const { starred } = await window.api.toggleStar(session.sessionId);
      session.starred = starred;
      refreshSidebar({ resort: true });
    });

    onAction(item, '.session-stop-btn', () => void confirmAndStopSession(session.sessionId));

    onAction(item, '.session-unread-btn', () => {
      if (isUnread(session.sessionId)) clearUnread(session.sessionId);
      else markUnread(session.sessionId);
      refreshSidebar();
    });

    onAction(item, '.session-launch-config-btn', () => void showResumeSessionDialog(session));
    onAction(item, '.session-jsonl-btn', () => void showJsonlViewer(session));
    onAction(item, '.session-fork-btn', () => void forkCurrent(session));
    onAction(item, '.session-archive-btn', () => void toggleArchive(session));

    const summary = item.querySelector<HTMLElement>('.session-summary');
    if (summary) summary.ondblclick = (e) => {
      e.stopPropagation();
      startRename(summary, session);
    };
  });
}

/** Bind a row action, stopping the click from also opening the session. */
function onAction(item: HTMLElement, selector: string, handler: () => void): void {
  const button = item.querySelector<HTMLElement>(selector);
  if (!button) return;
  button.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    handler();
  };
}

async function forkCurrent(session: SessionRow): Promise<void> {
  const project = projectOf(session.sessionId);
  if (project) await forkSession(session, project);
}

async function toggleArchive(session: SessionRow): Promise<void> {
  const archived = session.archived ? 0 : 1;
  if (!await archiveSessionRow(session, archived)) return;
  if (archived) void pollActiveSessions();
  void reloadProjects();
}

/**
 * Open the group holding the session on screen.
 *
 * Its terminal is visible, so leaving its row hidden inside a collapsed group
 * makes the sidebar disagree with the main area.
 */
function expandGroupHoldingActiveSession(): void {
  if (!view.activeSessionId) return;
  const item = sidebarContent.querySelector<HTMLElement>(
    `[data-session-id="${view.activeSessionId}"]`);
  const collapsed = item?.closest('.slug-group.collapsed');
  if (!collapsed) return;
  collapsed.classList.remove('collapsed');
  saveExpandedSlugs();
}

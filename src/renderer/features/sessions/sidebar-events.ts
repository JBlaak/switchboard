/**
 * Wiring up a freshly rendered session list.
 *
 * Handlers are assigned (`onclick =`) rather than added, and re-assigned after
 * every render — the list is morphed in place, so an element can survive a
 * redraw carrying a handler that closes over a stale row. Assignment makes that
 * idempotent; `addEventListener` would stack duplicates.
 */
import { refreshSidebar, reloadProjects } from '../../app/refresh';
import { sessionMap, view } from '../../state/session-store';
import { sidebarContent } from '../../lib/dom';
import { celebrate } from '../../lib/motion/celebrate';
import { bump, collapse, uncollapse } from '../../lib/motion/reflow';
import { motion, reducedMotion } from '../../lib/motion/spring';
import { showResumeSessionDialog } from '../dialogs/resume-session-dialog';
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
      archiveGroup(header, archiveBtn);
    };

    header.onclick = (e) => {
      if ((e.target as HTMLElement).closest('.slug-group-archive-btn')) return;
      if (isLeaving(header)) return;
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

/** Archive every unarchived session in one slug group, sliding the group out first. */
function archiveGroup(header: HTMLElement, button: HTMLElement): void {
  const group = header.parentElement;
  if (!group || isLeaving(group)) return;

  const sessions = [...group.querySelectorAll<HTMLElement>('.session-item')]
    .map(item => sessionMap.get(item.dataset.sessionId ?? ''))
    .filter((s): s is SessionRow => !!s && !s.archived);
  if (!sessions.length) return;

  celebrateFrom(button);
  leave(group, async () => {
    let ok = true;
    for (const session of sessions) {
      // One failure stops the sweep rather than silently skipping a session
      // whose PTY is still running.
      if (!await archiveSessionRow(session, 1)) {
        ok = false;
        break;
      }
    }
    void pollActiveSessions();
    void reloadProjects();
    return ok;
  });
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

    item.onclick = () => {
      if (!isLeaving(item)) void openSession(session);
    };

    onAction(item, '.session-pin', async (pin) => {
      const { starred } = await window.api.toggleStar(session.sessionId);
      session.starred = starred;
      // The star bump: a pin going in pops, one coming out dips. The next
      // morph may swap this element out; bumping the one we have is enough.
      bump(pin, starred ? 10 : -4);
      refreshSidebar({ resort: true });
    });

    onAction(item, '.session-stop-btn', () => void confirmAndStopSession(session.sessionId));

    onAction(item, '.session-launch-config-btn', () => void showResumeSessionDialog(session));
    onAction(item, '.session-archive-btn', (btn) => toggleArchive(item, btn, session));

    const summary = item.querySelector<HTMLElement>('.session-summary');
    if (summary) summary.ondblclick = (e) => {
      e.stopPropagation();
      startRename(summary, session);
    };
  });
}

/**
 * Bind a row action, stopping the click from also opening the session.
 *
 * A row on its way out takes no more actions: it is already being archived.
 */
function onAction(item: HTMLElement, selector: string, handler: (button: HTMLElement) => void): void {
  const button = item.querySelector<HTMLElement>(selector);
  if (!button) return;
  button.onclick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!isLeaving(item)) handler(button);
  };
}

/** Archive a row with confetti, or bring one back from the archive without; either way it slides out of this list. */
function toggleArchive(item: HTMLElement, button: HTMLElement, session: SessionRow): void {
  const archived = session.archived ? 0 : 1;
  if (archived) celebrateFrom(button);
  leave(item, async () => {
    if (!await archiveSessionRow(session, archived)) return false;
    if (archived) void pollActiveSessions();
    void reloadProjects();
    return true;
  });
}

/** Inside (or itself) a row or group that is sliding out. */
function isLeaving(el: HTMLElement): boolean {
  return !!el.closest('[data-leaving]');
}

function celebrateFrom(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  celebrate(r.left + r.width / 2, r.top + r.height / 2);
}

/**
 * Slide an element out the way BlaakTasks completes a task, then run `act`.
 *
 * The confetti gets a beat on its own, the row slides aside and dims, the list
 * closes the gap, and only then does the real work happen — so the row never
 * vanishes before you see it go. `data-leaving` tells the morph to keep its
 * hands off meanwhile. If `act` fails the element comes back.
 */
function leave(el: HTMLElement, act: () => Promise<boolean>): void {
  el.setAttribute('data-leaving', '');
  const run = (): void => {
    act().catch(() => false).then(ok => {
      if (!ok) comeBack(el);
    });
  };

  // No slide or collapse, but still a pause, so the change reads as one.
  if (reducedMotion()) {
    setTimeout(run, 450);
    return;
  }
  setTimeout(() => {
    const m = motion(el);
    m.fade = true;
    m.x.to(26);
    m.o.to(0.45);
  }, 260);
  setTimeout(() => collapse(el, run), 600);
}

function comeBack(el: HTMLElement): void {
  if (!el.isConnected) return;
  uncollapse(el);
  el.removeAttribute('data-leaving');
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

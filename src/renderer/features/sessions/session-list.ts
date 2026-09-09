/**
 * Fetching the session list, and keeping the invented rows honest.
 *
 * Two lists are fetched, not one: the sidebar needs the unarchived rows for its
 * normal view and all of them for the archive filter, and asking twice is
 * cheaper than the renderer filtering a list it would then have to keep in step
 * with the archive toggle.
 *
 * The rest is reconciliation. Rows the renderer invented for sessions the CLI
 * had not written yet have to be dropped once a real one arrives, re-injected
 * while one might still be coming, and evicted when it is clear none ever will.
 */
import { isPendingAbandoned } from '../../../domain/session/pending';
import { encodeProjectPath } from '../../../domain/project/project-path';
import { refreshSidebar } from '../../app/refresh';
import { dropPendingSession } from './session-actions';
import { pollActiveSessions } from './session-poller';
import {
  adoptSessions, injectIntoCaches, pendingSessions, sessionMap, view,
} from '../../state/session-store';
import { loadingStatus } from '../../lib/dom';
import type { Project } from '../../../domain/project/project';

export interface LoadOptions {
  resort?: boolean;
}

/** Re-fetch the projects, reconcile the pending rows, and redraw. */
export async function loadProjects({ resort = false }: LoadOptions = {}): Promise<void> {
  const showLoading = view.cachedProjects.length === 0;
  if (showLoading) {
    loadingStatus.textContent = 'Loading…';
    loadingStatus.className = 'active';
    loadingStatus.style.display = '';
  }

  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);

  view.cachedProjects = defaultProjects;
  view.cachedAllProjects = allProjects;
  loadingStatus.style.display = 'none';
  loadingStatus.className = '';

  adoptSessions(view.cachedProjects);
  adoptSessions(view.cachedAllProjects);

  reconcilePending(allProjects);
  await adoptActiveTerminals();

  await pollActiveSessions();
  refreshSidebar({ resort });
}

/**
 * Decide the fate of every row the renderer invented.
 *
 * Three outcomes: the real row arrived (forget the placeholder), nothing is
 * coming (evict it), or it is still plausible (re-inject it, because the
 * freshly fetched lists do not contain it).
 */
function reconcilePending(allProjects: readonly Project[]): void {
  for (const [sessionId, pending] of [...pendingSessions]) {
    const realExists = allProjects.some(p => p.sessions.some(s => s.sessionId === sessionId));
    if (realExists) {
      pendingSessions.delete(sessionId);
      continue;
    }

    const abandoned = isPendingAbandoned(pending, {
      running: view.activePtyIds.has(sessionId),
      onScreen: view.activeSessionId === sessionId,
    });
    if (abandoned) {
      dropPendingSession(sessionId);
      continue;
    }

    injectIntoCaches(pending.session, pending.folder, pending.session.type === 'remote');
  }
}

/**
 * Pick up plain terminals that are running but not tracked here.
 *
 * They exist only in the main process's memory, so a reloaded renderer learns
 * about them this way rather than from a transcript. The row itself comes from
 * the project list, which the main process injects them into.
 */
async function adoptActiveTerminals(): Promise<void> {
  let terminals: { sessionId: string; projectPath: string }[];
  try {
    terminals = await window.api.getActiveTerminals();
  } catch {
    return;
  }

  for (const { sessionId, projectPath } of terminals) {
    if (pendingSessions.has(sessionId)) continue;
    const session = findInCaches(sessionId);
    if (!session) continue;
    pendingSessions.set(sessionId, {
      session, projectPath, folder: encodeProjectPath(projectPath),
    });
    sessionMap.set(sessionId, session);
  }
}

function findInCaches(sessionId: string) {
  for (const project of view.cachedAllProjects) {
    const found = project.sessions.find(s => s.sessionId === sessionId);
    if (found) return found;
  }
  return undefined;
}

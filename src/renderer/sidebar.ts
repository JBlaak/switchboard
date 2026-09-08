// --- Sidebar rendering ---
// The session list is flat: one list of sessions across all projects, never
// grouped by directory. Sessions waiting on the user sort to the top, then the
// ones that finished unread, then the ones still working, then pinned, then the
// rest — each block most recent first. Sessions sharing a slug are still folded
// into a slug group, but only within their own project.
// Project-level actions (new session, settings, archive all, remove) live in the
// project picker dialog (dialogs.js), since there are no directory headers left
// to hang them off.
//
import {
  TIER_ATTENTION, TIER_LABELS, TIER_ORDER, TIER_PINNED, TIER_READY, TIER_REST,
  TIER_RUNNING, itemTier, rowSurvivesTruncation, sessionTier,
} from './session-tiers.js';
import { escapeHtml } from './utils.js';
import morphdom from 'morphdom';
import type { Project, SessionRow } from '../shared/types.js';
import { archiveSessionRow, clearUnread, confirmAndStopSession, getExpandedSlugs, loadProjects, markUnread, openSession, pollActiveSessions, refreshSidebar, saveExpandedSlugs } from './app.js';
import { forkSession, showResumeSessionDialog } from './dialogs.js';
import { sidebarContent } from './dom.js';
import { ICONS } from './icons.js';
import { showJsonlViewer } from './jsonl-viewer.js';
import { attentionSessions, openSessions, pendingSessions, responseReadySessions, sessionBusyState, sessionMap, state } from './state.js';
import { cleanDisplayName, formatDate, shortProjectPath } from './utils.js';

const WORKTREE_PATTERN = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;

/** A rendered row (or slug group), with what the ordering rules need from it. */
interface RenderItem {
  /** Epoch ms of the newest session behind this row. */
  sortTime: number;
  pinned: boolean;
  tier: number;
  remote: boolean;
  element: HTMLElement;
}

// The same slug can exist in two checkouts of the same repo; they stay two
// groups, so the project has to be part of the element id.
function slugId(slug: string, projectPath: string): string {
  return 'slug-' + (projectPath + '--' + slug).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Label shown on every row now that directory headers are gone. Worktrees read
// as "parent ⎇ branch" — their raw path ends in .claude/worktrees/<name>, which
// shortProjectPath would render as the useless "worktrees/<name>".
export function projectLabel(projectPath: string | null | undefined): string {
  if (!projectPath) return '';
  const match = projectPath.match(WORKTREE_PATTERN);
  if (match) return shortProjectPath(match[1]) + ' ⎇ ' + match[2];
  return shortProjectPath(projectPath);
}

// Move the entry identified by anchorId back to the index it held in prevIds,
// leaving everything else in its freshly sorted order. Keeps the session the
// user is working in parked where they last saw it while the rest of the list
// reshuffles by recency around it.
function anchorToPreviousIndex<T>(
  items: T[],
  anchorId: string | null,
  prevIds: string[] | null,
  getId: (item: T) => string,
): void {
  if (!anchorId || !prevIds) return;
  const from = items.findIndex(item => getId(item) === anchorId);
  const to = prevIds.indexOf(anchorId);
  if (from === -1 || to === -1 || from === to) return;
  const [item] = items.splice(from, 1);
  items.splice(Math.min(to, items.length), 0, item);
}

function buildSlugGroup(slug: string, sessions: SessionRow[], projectPath: string): HTMLElement {
  const group = document.createElement('div');
  const id = slugId(slug, projectPath);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group' : 'slug-group collapsed';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) =>
    new Date(b.modified).getTime() > new Date(a.modified).getTime() ? b : a);
  const displayName = cleanDisplayName(mostRecent.name || mostRecent.aiTitle || mostRecent.summary || slug);
  const mostRecentTime = new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName ?? '';

  const hasRunning = sessions.some((s: SessionRow) => state.activePtyIds.has(s.sessionId));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="session-project">${escapeHtml(projectLabel(projectPath))}</span><span class="slug-group-count">${sessions.length} sessions</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archive all sessions in group';
  archiveSlugBtn.innerHTML = ICONS.archive(14);

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (state.activePtyIds.has(session.sessionId)) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      sessionsContainer.appendChild(buildSessionItem(session, projectPath));
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        olderDiv.appendChild(buildSessionItem(session, projectPath));
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      sessionsContainer.appendChild(buildSessionItem(session, projectPath));
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

export function renderSessionList(projects: Project[], resort?: boolean): void {
  const newSidebar = document.createElement('div');
  const anyFilterActive = state.showStarredOnly || state.showRunningOnly || state.showTodayOnly || state.showArchived || state.searchMatchIds !== null;

  function passesFilters(sessions: SessionRow[]): SessionRow[] {
    let filtered = sessions;
    // The archive filter is the only way archived sessions surface: when it's on
    // we show exactly the archived ones, when it's off they're hidden entirely.
    if (state.showArchived) filtered = filtered.filter((s: SessionRow) => s.archived);
    if (state.showStarredOnly) filtered = filtered.filter((s: SessionRow) => s.starred);
    if (state.showRunningOnly) filtered = filtered.filter((s: SessionRow) => state.activePtyIds.has(s.sessionId));
    if (state.showTodayOnly) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filtered = filtered.filter((s: SessionRow) => {
        if (!s.modified) return false;
        const d = new Date(s.modified);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
      });
    }
    return filtered;
  }

  // Flatten every project's sessions into one list of render items. Sessions
  // sharing a slug still collapse into a slug group, but only within their own
  // project — the same slug in two checkouts stays two groups.
  const allItems = [];
  let activeItemId = null;
  for (const project of projects) {
    const projectPath = project.projectPath;
    const filtered = passesFilters(project.sessions);
    if (filtered.length === 0) continue;

    const slugMap = new Map();
    const ungrouped = [];
    for (const session of filtered) {
      if (session.slug) {
        if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
        slugMap.get(session.slug).push(session);
      } else {
        ungrouped.push(session);
      }
    }

    for (const session of ungrouped) {
      const element = buildSessionItem(session, projectPath);
      if (session.sessionId === state.activeSessionId) activeItemId = element.id;
      allItems.push({
        sortTime: new Date(session.modified).getTime(),
        pinned: !!session.starred,
        tier: sessionTier(session.sessionId),
        remote: session.type === 'remote',
        element,
      });
    }
    for (const [slug, sessions] of slugMap) {
      const sorted = [...sessions].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
      const element = sorted.length === 1
        ? buildSessionItem(sorted[0], projectPath)
        : buildSlugGroup(slug, sorted, projectPath);
      if (sorted.some((s: SessionRow) => s.sessionId === state.activeSessionId)) activeItemId = element.id;
      allItems.push({
        sortTime: Math.max(...sorted.map((s: SessionRow) => new Date(s.modified).getTime())),
        pinned: sorted.some((s: SessionRow) => s.starred),
        tier: Math.max(...sorted.map((s: SessionRow) => sessionTier(s.sessionId))),
        remote: sorted.some((s: SessionRow) => s.type === 'remote'),
        element,
      });
    }
  }

  // Order: sessions needing input first, then finished-but-unread, then still
  // working, then pinned, then the rest — most recent first inside each block.
  // The block holding the open session keeps it parked where the user last saw
  // it, so the list can't slide out from under the cursor as the rest reorders.
  const buckets = new Map<number, RenderItem[]>();
  for (const item of allItems) {
    const tier = itemTier(item);
    if (!buckets.has(tier)) buckets.set(tier, []);
    buckets.get(tier)!.push(item);
  }
  const ordered: { item: RenderItem; tier: number }[] = [];
  for (const tier of TIER_ORDER) {
    const bucket = buckets.get(tier);
    if (!bucket) continue;
    bucket.sort((a, b) => b.sortTime - a.sortTime);
    // Anchoring only holds while the session stays in the same block: once its
    // tier changes, the slot it used to occupy belongs to another section, and
    // holding it there would file the row under the wrong heading.
    if (!resort && activeItemId) {
      const prevIds = state.sortedOrder.filter(e => e.tier === tier).map(e => e.id);
      anchorToPreviousIndex(bucket, activeItemId, prevIds, (item: RenderItem) => item.element.id);
    }
    for (const item of bucket) ordered.push({ item, tier });
  }

  let visible: { item: RenderItem; tier: number }[] = [];
  let older = [];
  if (anyFilterActive) {
    visible = ordered;
  } else {
    let count = 0;
    const ageCutoff = Date.now() - state.sessionMaxAgeDays * 86400000;
    for (const entry of ordered) {
      const { item, tier } = entry;
      if (rowSurvivesTruncation(item, tier, {
        count, visibleSessionCount: state.visibleSessionCount, ageCutoff,
        isActive: item.element.id === activeItemId,
      })) {
        visible.push(entry);
        count++;
      } else {
        older.push(entry);
      }
    }
    if (visible.length === 0 && older.length > 0) { visible = older; older = []; }
  }

  const list = document.createElement('div');
  list.className = 'session-list';
  list.id = 'session-list';

  let lastTier = null;
  for (const { item, tier } of visible) {
    if (!anyFilterActive && tier !== lastTier) {
      const label = document.createElement('div');
      label.className = 'session-section-label';
      label.id = 'section-' + tier;
      label.textContent = TIER_LABELS[tier];
      list.appendChild(label);
      lastTier = tier;
    }
    list.appendChild(item.element);
  }

  if (older.length > 0) {
    const moreBtn = document.createElement('div');
    moreBtn.className = 'sessions-more-toggle';
    moreBtn.id = 'older-all';
    moreBtn.textContent = `+ ${older.length} older`;
    const olderList = document.createElement('div');
    olderList.className = 'sessions-older';
    olderList.id = 'older-list-all';
    olderList.style.display = 'none';
    for (const { item } of older) olderList.appendChild(item.element);
    list.appendChild(moreBtn);
    list.appendChild(olderList);
  }

  newSidebar.appendChild(list);

  // Re-apply active state
  if (state.activeSessionId) {
    const activeItem = newSidebar.querySelector<HTMLElement>(`[data-session-id="${state.activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Skip updating session items that have an active rename input
      if (fromEl.classList.contains('session-item') && fromEl.querySelector<HTMLElement>('.session-rename-input')) {
        return false;
      }
      if (fromEl.classList.contains('slug-group')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
        toEl.textContent = '- hide older';
      }
      if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
      }
      return true;
    },
    getNodeKey(node: Node) {
      return (node as HTMLElement).id || undefined;
    }
  });

  // Save the rendered order (id + the block it landed in) as the source of
  // truth for the next render
  state.sortedOrder = ordered.map(({ item, tier }) => ({ id: item.element.id, tier }));

  rebindSidebarEvents();

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement as HTMLElement | null;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  const open = state.activeSessionId ? openSessions.get(state.activeSessionId) : undefined;
  if (open && !isUserTyping) {
    open.terminal.focus();
  }
}

// Session rows and slug groups only; project-level actions live in the picker.
function rebindSidebarEvents() {
  sidebarContent.querySelectorAll<HTMLElement>('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector<HTMLElement>('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e: MouseEvent) => {
        e.stopPropagation();
        const group = header.parentElement;
        if (!group) return;
        const sessionItems = group.querySelectorAll<HTMLElement>('.session-item');
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sid ? sessionMap.get(sid) : undefined;
          if (!session || session.archived) continue;
          // One failure stops the sweep rather than silently skipping a session
          // whose PTY is still running.
          if (!await archiveSessionRow(session, 1)) break;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.slug-group-archive-btn')) return;
      header.parentElement?.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  sidebarContent.querySelectorAll<HTMLElement>('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  sidebarContent.querySelectorAll<HTMLElement>('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling as HTMLElement | null;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.children.length;
    moreBtn.onclick = () => {
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      moreBtn.textContent = showing ? `+ ${count} older` : '- hide older';
    };
  });

  sidebarContent.querySelectorAll<HTMLElement>('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionId ? sessionMap.get(sessionId) : undefined;
    if (!session) return;

    item.onclick = () => openSession(session);

    const pin = item.querySelector<HTMLElement>('.session-pin');
    if (pin) {
      pin.onclick = async (e: MouseEvent) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector<HTMLElement>('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector<HTMLElement>('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        confirmAndStopSession(session.sessionId);
      };
    }

    const unreadBtn = item.querySelector<HTMLElement>('.session-unread-btn');
    if (unreadBtn) {
      unreadBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        if (responseReadySessions.has(session.sessionId)) {
          clearUnread(session.sessionId);
        } else {
          markUnread(session.sessionId);
        }
        refreshSidebar();
      };
    }

    const launchConfigBtn = item.querySelector<HTMLElement>('.session-launch-config-btn');
    if (launchConfigBtn) {
      launchConfigBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        showResumeSessionDialog(session);
      };
    }

    const forkBtn = item.querySelector<HTMLElement>('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e: MouseEvent) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...state.cachedAllProjects, ...state.cachedProjects].find(p =>
          p.sessions.some((s: SessionRow) => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const jsonlBtn = item.querySelector<HTMLElement>('.session-jsonl-btn');
    if (jsonlBtn) {
      jsonlBtn.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        showJsonlViewer(session);
      };
    }

    const archiveBtn = item.querySelector<HTMLElement>('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e: MouseEvent) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        const ok = await archiveSessionRow(session, newVal);
        if (!ok) return;
        if (newVal) pollActiveSessions();
        loadProjects();
      };
    }
  });

  // Auto-expand slug group if it contains the active session
  if (state.activeSessionId) {
    const activeItem = sidebarContent.querySelector<HTMLElement>(`[data-session-id="${state.activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

function buildSessionItem(session: SessionRow, projectPath: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (state.activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
  item.dataset.sessionId = session.sessionId;

  const modified = new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Pin
  const pin = document.createElement('span');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.innerHTML = session.starred
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>';

  // Running status dot
  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (state.activePtyIds.has(session.sessionId) ? ' running' : '');

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName ?? '';

  // Compact meta line: project + time + msgs on the left, first UUID segment on
  // the right. The 30s label ticker in app.js updates .session-time only, so it
  // must stay its own span.
  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  const timeEl = document.createElement('span');
  timeEl.className = 'session-time';
  timeEl.textContent = timeStr + (session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '');
  const shortIdEl = document.createElement('span');
  shortIdEl.className = 'session-short-id';
  shortIdEl.title = session.sessionId;
  shortIdEl.textContent = session.sessionId.split('-')[0];
  // The directory is no longer a header above the row, so each row names its
  // own project (and branch, for worktrees).
  const path = projectPath || session.projectPath;
  const label = projectLabel(path);
  const metaLeft = document.createElement('span');
  metaLeft.className = 'session-meta-left';
  if (label) {
    const projectEl = document.createElement('span');
    projectEl.className = 'session-project';
    projectEl.textContent = label;
    projectEl.title = path || '';
    if (path && path.startsWith('ssh://')) projectEl.classList.add('is-remote');
    metaLeft.appendChild(projectEl);
  }
  metaLeft.appendChild(timeEl);
  metaEl.append(metaLeft, shortIdEl);

  if (session.type === 'terminal' || (session.type === 'remote' && session.remoteKind === 'shell')) {
    const badge = document.createElement('span');
    badge.className = 'terminal-badge';
    badge.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
    summaryEl.prepend(badge);
  }
  info.appendChild(summaryEl);
  info.appendChild(metaEl);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'session-stop-btn';
  stopBtn.title = session.type === 'remote' ? 'Disconnect (keeps running on the remote)' : 'Stop session';
  stopBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.innerHTML = ICONS.archive(16);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const jsonlBtn = document.createElement('button');
  jsonlBtn.className = 'session-jsonl-btn';
  jsonlBtn.title = 'View messages';
  jsonlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';

  const launchConfigBtn = document.createElement('button');
  launchConfigBtn.className = 'session-launch-config-btn';
  launchConfigBtn.title = 'Resume with config';
  launchConfigBtn.innerHTML = ICONS.launchConfig(14);

  const isUnread = responseReadySessions.has(session.sessionId);
  const unreadBtn = document.createElement('button');
  unreadBtn.className = 'session-unread-btn';
  unreadBtn.title = isUnread ? 'Mark as read' : 'Mark as unread';
  unreadBtn.innerHTML = isUnread ? ICONS.markRead(14) : ICONS.markUnread(14);

  actions.appendChild(stopBtn);
  actions.appendChild(unreadBtn);
  if (session.type === 'remote') {
    // No local jsonl to fork/view/relaunch from. Archive still works — it's
    // keyed on sessionId in session_meta — and doubles as "forget this one".
    actions.appendChild(archiveBtn);
  } else if (session.type !== 'terminal') {
    actions.appendChild(forkBtn);
    actions.appendChild(jsonlBtn);
    actions.appendChild(archiveBtn);
    actions.appendChild(launchConfigBtn);
  }

  row.appendChild(pin);
  row.appendChild(dot);
  row.appendChild(info);
  row.appendChild(actions);
  item.appendChild(row);

  return item;
}

function startRename(summaryEl: HTMLElement, session: SessionRow): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.aiTitle || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const fallback = session.aiTitle || session.summary;
    const nameToSave = (newName && newName !== fallback) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || fallback;
    newSummary.addEventListener('dblclick', (e: MouseEvent) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.aiTitle || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
}


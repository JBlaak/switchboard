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
// Depends on globals: sidebarContent, openSessions, activeSessionId, activePtyIds,
// pendingSessions, sessionMap, sortedOrder, searchMatchIds,
// searchMatchProjectPaths, showStarredOnly, showRunningOnly, showTodayOnly,
// showArchived, visibleSessionCount, sessionMaxAgeDays, attentionSessions,
// responseReadySessions, sessionBusyState, cachedProjects, cachedAllProjects,
// gridCards, gridViewActive (app.js)
// Depends on: cleanDisplayName, formatDate, escapeHtml, shortProjectPath (utils.js),
// ICONS (icons.js), showSession (terminal-manager.js), confirmAndStopSession,
// pollActiveSessions, showResumeSessionDialog, showJsonlViewer, forkSession,
// openSession, loadProjects, markUnread, clearUnread, refreshSidebar
// (app.js/dialogs.js)

const WORKTREE_PATTERN = /^(.+?)\/\.claude\/worktrees\/([^/]+)\/?$/;

// The same slug can exist in two checkouts of the same repo; they stay two
// groups, so the project has to be part of the element id.
function slugId(slug, projectPath) {
  return 'slug-' + (projectPath + '--' + slug).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Label shown on every row now that directory headers are gone. Worktrees read
// as "parent ⎇ branch" — their raw path ends in .claude/worktrees/<name>, which
// shortProjectPath would render as the useless "worktrees/<name>".
function projectLabel(projectPath) {
  if (!projectPath) return '';
  const match = projectPath.match(WORKTREE_PATTERN);
  if (match) return shortProjectPath(match[1]) + ' ⎇ ' + match[2];
  return shortProjectPath(projectPath);
}

// Move the entry identified by anchorId back to the index it held in prevIds,
// leaving everything else in its freshly sorted order. Keeps the session the
// user is working in parked where they last saw it while the rest of the list
// reshuffles by recency around it.
function anchorToPreviousIndex(items, anchorId, prevIds, getId) {
  if (!anchorId || !prevIds) return;
  const from = items.findIndex(item => getId(item) === anchorId);
  const to = prevIds.indexOf(anchorId);
  if (from === -1 || to === -1 || from === to) return;
  const [item] = items.splice(from, 1);
  items.splice(Math.min(to, items.length), 0, item);
}

function buildSlugGroup(slug, sessions, projectPath) {
  const group = document.createElement('div');
  const id = slugId(slug, projectPath);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group' : 'slug-group collapsed';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) =>
    new Date(b.modified) > new Date(a.modified) ? b : a);
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
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

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
    if (activePtyIds.has(session.sessionId)) {
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

// Sort tiers, highest first. The active block is split by what the session
// wants from the user: first the ones blocking on input, then the ones that
// finished and haven't been read, then the ones still working. Those three
// always outrank pinned and plain recent rows regardless of age.
const TIER_ATTENTION = 4;
const TIER_READY = 3;
const TIER_RUNNING = 2;
const TIER_PINNED = 1;
const TIER_REST = 0;

const TIER_ORDER = [TIER_ATTENTION, TIER_READY, TIER_RUNNING, TIER_PINNED, TIER_REST];

const TIER_LABELS = {
  [TIER_ATTENTION]: 'Needs input',
  [TIER_READY]: 'Ready',
  [TIER_RUNNING]: 'Working',
  [TIER_PINNED]: 'Pinned',
  [TIER_REST]: 'Recent',
};

// A live session that isn't spinning has finished its turn, whether or not the
// user has read it yet — both count as ready. Only a session reported as busy
// (or one still starting up) is working. Busy state comes from the OSC 0 spinner,
// so a session idle since before this window opened reads as ready, which is
// what it is.
function sessionTier(sessionId) {
  if (attentionSessions.has(sessionId)) return TIER_ATTENTION;
  if (responseReadySessions.has(sessionId)) return TIER_READY;
  if (sessionBusyState.get(sessionId)) return TIER_RUNNING;
  // A pending row counts as working only while a PTY is actually running under
  // it. Once that's gone it is a placeholder awaiting cleanup, and filing it
  // under Working both misreports it and — via rowSurvivesTruncation — makes it
  // impossible to age out of the list.
  if (pendingSessions.has(sessionId) && activePtyIds.has(sessionId)) return TIER_RUNNING;
  if (activePtyIds.has(sessionId)) return TIER_READY;
  return TIER_REST;
}

// Whether a row escapes the sidebar's truncation. Live and pinned rows are
// never hidden, and neither is the open session; everything else is capped by
// visibleSessionCount and the age cutoff.
//
// Remote sessions are exempt from both caps. Their work lives in a tmux session
// on the remote host that keeps running whether or not Switchboard is connected,
// and their `modified` only moves when the user opens them — there is no local
// jsonl whose writes could keep the timestamp current. So a remote session that
// had been working for days looked stale, aged out of the list, and read as if
// it had been archived on its own. They are a small, deliberately added set;
// Archive (or removing the remote) is the only thing that should drop one.
function rowSurvivesTruncation(item, tier, { count, visibleSessionCount, ageCutoff, isActive }) {
  if (tier >= TIER_RUNNING || item.pinned || item.remote || isActive) return true;
  return count < visibleSessionCount && item.sortTime >= ageCutoff;
}

// Pinning only decides where a row lands once it has nothing live to say.
function itemTier(item) {
  if (item.tier >= TIER_RUNNING) return item.tier;
  if (item.pinned) return TIER_PINNED;
  return TIER_REST;
}

function renderSessionList(projects, resort) {
  const newSidebar = document.createElement('div');
  const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || showArchived || searchMatchIds !== null;

  function passesFilters(sessions) {
    let filtered = sessions;
    // The archive filter is the only way archived sessions surface: when it's on
    // we show exactly the archived ones, when it's off they're hidden entirely.
    if (showArchived) filtered = filtered.filter(s => s.archived);
    if (showStarredOnly) filtered = filtered.filter(s => s.starred);
    if (showRunningOnly) filtered = filtered.filter(s => activePtyIds.has(s.sessionId));
    if (showTodayOnly) {
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      filtered = filtered.filter(s => {
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
      if (session.sessionId === activeSessionId) activeItemId = element.id;
      allItems.push({
        sortTime: new Date(session.modified).getTime(),
        pinned: !!session.starred,
        tier: sessionTier(session.sessionId),
        remote: session.type === 'remote',
        element,
      });
    }
    for (const [slug, sessions] of slugMap) {
      const sorted = [...sessions].sort((a, b) => new Date(b.modified) - new Date(a.modified));
      const element = sorted.length === 1
        ? buildSessionItem(sorted[0], projectPath)
        : buildSlugGroup(slug, sorted, projectPath);
      if (sorted.some(s => s.sessionId === activeSessionId)) activeItemId = element.id;
      allItems.push({
        sortTime: Math.max(...sorted.map(s => new Date(s.modified).getTime())),
        pinned: sorted.some(s => s.starred),
        tier: Math.max(...sorted.map(s => sessionTier(s.sessionId))),
        remote: sorted.some(s => s.type === 'remote'),
        element,
      });
    }
  }

  // Order: sessions needing input first, then finished-but-unread, then still
  // working, then pinned, then the rest — most recent first inside each block.
  // The block holding the open session keeps it parked where the user last saw
  // it, so the list can't slide out from under the cursor as the rest reorders.
  const buckets = new Map();
  for (const item of allItems) {
    const tier = itemTier(item);
    if (!buckets.has(tier)) buckets.set(tier, []);
    buckets.get(tier).push(item);
  }
  const ordered = [];
  for (const tier of TIER_ORDER) {
    const bucket = buckets.get(tier);
    if (!bucket) continue;
    bucket.sort((a, b) => b.sortTime - a.sortTime);
    // Anchoring only holds while the session stays in the same block: once its
    // tier changes, the slot it used to occupy belongs to another section, and
    // holding it there would file the row under the wrong heading.
    if (!resort && activeItemId) {
      const prevIds = sortedOrder.filter(e => e.tier === tier).map(e => e.id);
      anchorToPreviousIndex(bucket, activeItemId, prevIds, item => item.element.id);
    }
    for (const item of bucket) ordered.push({ item, tier });
  }

  let visible = [];
  let older = [];
  if (anyFilterActive) {
    visible = ordered;
  } else {
    let count = 0;
    const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
    for (const entry of ordered) {
      const { item, tier } = entry;
      if (rowSurvivesTruncation(item, tier, {
        count, visibleSessionCount, ageCutoff,
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
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Skip updating session items that have an active rename input
      if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
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
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the rendered order (id + the block it landed in) as the source of
  // truth for the next render
  sortedOrder = ordered.map(({ item, tier }) => ({ id: item.element.id, tier }));

  rebindSidebarEvents();

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

// Session rows and slug groups only; project-level actions live in the picker.
function rebindSidebarEvents() {
  sidebarContent.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        const sessionItems = group.querySelectorAll('.session-item');
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sessionMap.get(sid);
          if (!session || session.archived) continue;
          // One failure stops the sweep rather than silently skipping a session
          // whose PTY is still running.
          if (!await archiveSessionRow(session, 1)) break;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  sidebarContent.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  sidebarContent.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.children.length;
    moreBtn.onclick = () => {
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      moreBtn.textContent = showing ? `+ ${count} older` : '- hide older';
    };
  });

  sidebarContent.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    item.onclick = () => openSession(session);

    const pin = item.querySelector('.session-pin');
    if (pin) {
      pin.onclick = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        confirmAndStopSession(session.sessionId);
      };
    }

    const unreadBtn = item.querySelector('.session-unread-btn');
    if (unreadBtn) {
      unreadBtn.onclick = (e) => {
        e.stopPropagation();
        if (responseReadySessions.has(session.sessionId)) {
          clearUnread(session.sessionId);
        } else {
          markUnread(session.sessionId);
        }
        refreshSidebar();
      };
    }

    const launchConfigBtn = item.querySelector('.session-launch-config-btn');
    if (launchConfigBtn) {
      launchConfigBtn.onclick = (e) => {
        e.stopPropagation();
        showResumeSessionDialog(session);
      };
    }

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const jsonlBtn = item.querySelector('.session-jsonl-btn');
    if (jsonlBtn) {
      jsonlBtn.onclick = (e) => {
        e.stopPropagation();
        showJsonlViewer(session);
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
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
  if (activeSessionId) {
    const activeItem = sidebarContent.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

function buildSessionItem(session, projectPath) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
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
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;

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

function startRename(summaryEl, session) {
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
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
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

// Expose pure helpers to Node for unit testing. No-op in the browser, where this
// file is loaded as a plain <script> and `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    rowSurvivesTruncation, sessionTier,
    TIER_ATTENTION, TIER_READY, TIER_RUNNING, TIER_PINNED, TIER_REST,
  };
}

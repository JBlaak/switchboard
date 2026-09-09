/**
 * Building one session row, and one slug group.
 *
 * Markup only: every row is built with no handlers attached, and
 * `sidebar-events` binds them after the list has been morphed into place. That
 * split is what lets the render be a pure function of state — rebuilding a row
 * cannot orphan a listener, because there were none on it.
 */
import { cleanDisplayName } from '../../../domain/session/title';
import { byMostRecentlyModified } from '../../../domain/session/session';
import {
  attentionSessions, isUnread, responseReadySessions, sessionBusyState,
} from '../../state/activity-store';
import { view } from '../../state/session-store';
import { escapeHtml, formatDate } from '../../lib/format';
import { ICONS } from '../../lib/icons';
import { getExpandedSlugs } from './active-session';
import { projectLabel } from './project-label';
import type { SessionRow } from '../../../domain/session/session';

/** Inline SVGs used by the row. Kept here because they are markup, not icons. */
const SVG = {
  pinFilled: '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>',
  pinOutline: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>',
  fork: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>',
  messages: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',
  terminal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
};

/**
 * The element id for a slug group.
 *
 * The same slug can exist in two checkouts of the same repo; they stay two
 * groups, so the project has to be part of the id.
 */
export function slugId(slug: string, projectPath: string): string {
  return 'slug-' + (projectPath + '--' + slug).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The label a session shows: its name, its AI title, or its first prompt. */
export function sessionDisplayName(session: SessionRow): string {
  return cleanDisplayName(session.name || session.aiTitle || session.summary) ?? '';
}

function button(className: string, title: string, html: string): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = className;
  el.title = title;
  el.innerHTML = html;
  return el;
}

export function buildSessionItem(session: SessionRow, projectPath: string): HTMLElement {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  item.dataset.sessionId = session.sessionId;

  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (view.activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');

  const row = document.createElement('div');
  row.className = 'session-row';
  row.append(
    buildPin(session),
    buildStatusDot(session),
    buildInfo(session, projectPath),
    buildActions(session),
  );
  item.appendChild(row);
  return item;
}

function buildPin(session: SessionRow): HTMLElement {
  const pin = document.createElement('span');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.innerHTML = session.starred ? SVG.pinFilled : SVG.pinOutline;
  return pin;
}

function buildStatusDot(session: SessionRow): HTMLElement {
  const dot = document.createElement('span');
  dot.className = 'session-status-dot'
    + (view.activePtyIds.has(session.sessionId) ? ' running' : '');
  return dot;
}

function buildInfo(session: SessionRow, projectPath: string): HTMLElement {
  const info = document.createElement('div');
  info.className = 'session-info';

  const summary = document.createElement('div');
  summary.className = 'session-summary';
  summary.textContent = sessionDisplayName(session);

  // A terminal — local or remote — gets a glyph rather than a word, because
  // its label is already "Terminal".
  if (session.type === 'terminal' || (session.type === 'remote' && session.remoteKind === 'shell')) {
    const badge = document.createElement('span');
    badge.className = 'terminal-badge';
    badge.innerHTML = SVG.terminal;
    summary.prepend(badge);
  }

  info.append(summary, buildMeta(session, projectPath));
  return info;
}

/**
 * The compact meta line: project, time and message count on the left, the
 * session's first id segment on the right.
 *
 * The 30-second label ticker updates `.session-time` only, so it has to stay
 * its own span.
 */
function buildMeta(session: SessionRow, projectPath: string): HTMLElement {
  const meta = document.createElement('div');
  meta.className = 'session-meta';

  const left = document.createElement('span');
  left.className = 'session-meta-left';

  const path = projectPath || session.projectPath;
  const label = projectLabel(path);
  if (label) {
    const project = document.createElement('span');
    project.className = 'session-project';
    project.textContent = label;
    project.title = path || '';
    if (path?.startsWith('ssh://')) project.classList.add('is-remote');
    left.appendChild(project);
  }

  const time = document.createElement('span');
  time.className = 'session-time';
  time.textContent = sessionTimeLabel(session);
  left.appendChild(time);

  const shortId = document.createElement('span');
  shortId.className = 'session-short-id';
  shortId.title = session.sessionId;
  shortId.textContent = session.sessionId.split('-')[0];

  meta.append(left, shortId);
  return meta;
}

/** The relative time plus the message count — the ticker rewrites this. */
export function sessionTimeLabel(session: SessionRow): string {
  const suffix = session.messageCount ? ' · ' + session.messageCount + ' msgs' : '';
  return formatDate(new Date(session.modified)) + suffix;
}

/**
 * The row's action buttons.
 *
 * Which ones appear depends on what the session actually supports. A remote
 * session has no local transcript to fork, view or relaunch from; archive still
 * works — it is keyed on the session id alone — and doubles as "forget this
 * one". A plain terminal has nothing to archive or resume either.
 */
function buildActions(session: SessionRow): HTMLElement {
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  actions.appendChild(button(
    'session-stop-btn',
    session.type === 'remote' ? 'Disconnect (keeps running on the remote)' : 'Stop session',
    SVG.stop));

  const unread = isUnread(session.sessionId);
  actions.appendChild(button(
    'session-unread-btn',
    unread ? 'Mark as read' : 'Mark as unread',
    unread ? ICONS.markRead(14) : ICONS.markUnread(14)));

  const archive = button(
    'session-archive-btn',
    session.archived ? 'Unarchive' : 'Archive',
    ICONS.archive(16));

  if (session.type === 'remote') {
    actions.appendChild(archive);
  } else if (session.type !== 'terminal') {
    actions.append(
      button('session-fork-btn', 'Fork session', SVG.fork),
      button('session-jsonl-btn', 'View messages', SVG.messages),
      archive,
      button('session-launch-config-btn', 'Resume with config', ICONS.launchConfig(14)),
    );
  }

  return actions;
}

/**
 * A group of sessions sharing a slug.
 *
 * Sessions started from one accepted plan share its slug, and showing them as
 * one collapsible row is what stops a single long-running task from filling the
 * sidebar. A group with something running promotes those to the top and hides
 * the rest behind a "more" toggle, so the live one is always visible even while
 * the group is collapsed.
 */
export function buildSlugGroup(
  slug: string,
  sessions: readonly SessionRow[],
  projectPath: string,
): HTMLElement {
  const id = slugId(slug, projectPath);
  const group = document.createElement('div');
  group.id = id;
  group.className = getExpandedSlugs().has(id) ? 'slug-group' : 'slug-group collapsed';

  const mostRecent = [...sessions].sort(byMostRecentlyModified)[0];
  const hasRunning = sessions.some(s => view.activePtyIds.has(s.sessionId));

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const name = document.createElement('div');
  name.className = 'slug-group-name';
  name.textContent = cleanDisplayName(
    mostRecent.name || mostRecent.aiTitle || mostRecent.summary || slug) ?? '';

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML =
    `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span>` +
    `<span class="session-project">${escapeHtml(projectLabel(projectPath))}</span>` +
    `<span class="slug-group-count">${sessions.length} sessions</span> ` +
    escapeHtml(formatDate(new Date(mostRecent.modified)));

  info.append(name, meta);
  row.append(expand, info, button(
    'slug-group-archive-btn', 'Archive all sessions in group', ICONS.archive(14)));
  header.appendChild(row);

  group.append(header, buildGroupSessions(group, id, sessions, projectPath));
  return group;
}

function buildGroupSessions(
  group: HTMLElement,
  id: string,
  sessions: readonly SessionRow[],
  projectPath: string,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'slug-group-sessions';

  const promoted = sessions.filter(s => view.activePtyIds.has(s.sessionId));
  const rest = sessions.filter(s => !view.activePtyIds.has(s.sessionId));

  if (promoted.length === 0) {
    for (const session of sessions) container.appendChild(buildSessionItem(session, projectPath));
    return container;
  }

  group.classList.add('has-promoted');
  for (const session of promoted) container.appendChild(buildSessionItem(session, projectPath));

  if (rest.length === 0) return container;

  const more = document.createElement('div');
  more.className = 'slug-group-more';
  more.id = 'sgm-' + id;
  more.textContent = `+ ${rest.length} more`;

  const older = document.createElement('div');
  older.className = 'slug-group-older';
  older.id = 'sgo-' + id;
  for (const session of rest) older.appendChild(buildSessionItem(session, projectPath));

  container.append(more, older);
  return container;
}

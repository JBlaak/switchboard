/**
 * Drawing the session list.
 *
 * One flat list across every project, never grouped by directory. Sessions
 * waiting on the user sort to the top, then the ones that finished unread, then
 * the ones still working, then pinned, then the rest — each block most recent
 * first. Sessions sharing a slug still fold into a group, but only within their
 * own project.
 *
 * Two things make the list usable rather than merely correct. It is *anchored*:
 * the session the user is working in keeps the slot it already had, so the list
 * cannot slide out from under the cursor while the rest reorders. And it is
 * *morphed* rather than replaced, so scroll position, an open rename input and
 * an expanded group all survive a redraw.
 */
import morphdom from 'morphdom';
import { byMostRecentlyModified } from '../../../domain/session/session';
import {
  TIER_LABELS, TIER_ORDER, itemTier, rowSurvivesTruncation,
} from '../../../domain/session/tiers';
import { tierOf } from '../../state/activity-store';
import { isFiltering, openSessions, view } from '../../state/session-store';
import { localDateKey } from '../../lib/format';
import { sidebarContent } from '../../lib/dom';
import { bindSidebarEvents } from './sidebar-events';
import { buildSessionItem, buildSlugGroup } from './sidebar-row';
import type { Project } from '../../../domain/project/project';
import type { SessionRow } from '../../../domain/session/session';

/** A rendered row (or slug group), with what the ordering rules need from it. */
interface RenderItem {
  /** Epoch ms of the newest session behind this row. */
  sortTime: number;
  pinned: boolean;
  tier: number;
  remote: boolean;
  element: HTMLElement;
}

interface OrderedItem {
  item: RenderItem;
  tier: number;
}

export function renderSessionList(projects: readonly Project[], resort = false): void {
  const filtering = isFiltering();
  const { items, activeItemId } = buildItems(projects);
  const ordered = orderItems(items, activeItemId, resort);
  const { visible, older } = filtering
    ? { visible: ordered, older: [] as OrderedItem[] }
    : truncate(ordered, activeItemId);

  const next = document.createElement('div');
  next.appendChild(buildList(visible, older, filtering));

  if (view.activeSessionId) {
    next.querySelector<HTMLElement>(`[data-session-id="${view.activeSessionId}"]`)
      ?.classList.add('active');
  }

  morphdom(sidebarContent, next, {
    childrenOnly: true,
    onBeforeElUpdated: preserveInteractionState,
    getNodeKey: (node: Node) => (node as HTMLElement).id || undefined,
  });

  // The rendered order is the source of truth the next render anchors against.
  view.sortedOrder = ordered.map(({ item, tier }) => ({ id: item.element.id, tier }));

  bindSidebarEvents();
  restoreTerminalFocus();
}

// ── Building ──

function passesFilters(sessions: readonly SessionRow[]): SessionRow[] {
  let filtered = [...sessions];
  // The archive filter is the only way archived sessions surface: when it is on
  // we show exactly the archived ones, when it is off they are hidden entirely.
  if (view.showArchived) filtered = filtered.filter(s => s.archived);
  if (view.showStarredOnly) filtered = filtered.filter(s => s.starred);
  if (view.showRunningOnly) filtered = filtered.filter(s => view.activePtyIds.has(s.sessionId));
  if (view.showTodayOnly) {
    const today = localDateKey(new Date());
    filtered = filtered.filter(s => s.modified && localDateKey(new Date(s.modified)) === today);
  }
  return filtered;
}

/**
 * Flatten every project's sessions into one list of render items.
 *
 * Sessions sharing a slug collapse into a group, but only within their own
 * project — the same slug in two checkouts stays two groups.
 */
function buildItems(projects: readonly Project[]): { items: RenderItem[]; activeItemId: string | null } {
  const items: RenderItem[] = [];
  let activeItemId: string | null = null;

  for (const project of projects) {
    const filtered = passesFilters(project.sessions);
    if (filtered.length === 0) continue;

    const bySlug = new Map<string, SessionRow[]>();
    const ungrouped: SessionRow[] = [];
    for (const session of filtered) {
      if (!session.slug) {
        ungrouped.push(session);
        continue;
      }
      const group = bySlug.get(session.slug);
      if (group) group.push(session);
      else bySlug.set(session.slug, [session]);
    }

    for (const session of ungrouped) {
      const element = buildSessionItem(session, project.projectPath);
      if (session.sessionId === view.activeSessionId) activeItemId = element.id;
      items.push({
        sortTime: new Date(session.modified).getTime(),
        pinned: !!session.starred,
        tier: tierOf(session.sessionId),
        remote: session.type === 'remote',
        element,
      });
    }

    for (const [slug, sessions] of bySlug) {
      const sorted = [...sessions].sort(byMostRecentlyModified);
      const element = sorted.length === 1
        ? buildSessionItem(sorted[0], project.projectPath)
        : buildSlugGroup(slug, sorted, project.projectPath);
      if (sorted.some(s => s.sessionId === view.activeSessionId)) activeItemId = element.id;
      items.push({
        sortTime: Math.max(...sorted.map(s => new Date(s.modified).getTime())),
        pinned: sorted.some(s => !!s.starred),
        tier: Math.max(...sorted.map(s => tierOf(s.sessionId))),
        remote: sorted.some(s => s.type === 'remote'),
        element,
      });
    }
  }

  return { items, activeItemId };
}

// ── Ordering ──

/**
 * Move the anchored entry back to the index it held last render, leaving
 * everything else in its freshly sorted order.
 *
 * Keeps the session the user is working in parked where they last saw it while
 * the rest of the list reshuffles by recency around it.
 */
function anchorToPreviousIndex(
  items: RenderItem[],
  anchorId: string,
  previousIds: readonly string[],
): void {
  const from = items.findIndex(item => item.element.id === anchorId);
  const to = previousIds.indexOf(anchorId);
  if (from === -1 || to === -1 || from === to) return;
  const [item] = items.splice(from, 1);
  items.splice(Math.min(to, items.length), 0, item);
}

function orderItems(
  items: readonly RenderItem[],
  activeItemId: string | null,
  resort: boolean,
): OrderedItem[] {
  const buckets = new Map<number, RenderItem[]>();
  for (const item of items) {
    const tier = itemTier(item);
    const bucket = buckets.get(tier);
    if (bucket) bucket.push(item);
    else buckets.set(tier, [item]);
  }

  const ordered: OrderedItem[] = [];
  for (const tier of TIER_ORDER) {
    const bucket = buckets.get(tier);
    if (!bucket) continue;
    bucket.sort((a, b) => b.sortTime - a.sortTime);
    // Anchoring only holds while the session stays in the same block: once its
    // tier changes, the slot it used to occupy belongs to another section, and
    // holding it there would file the row under the wrong heading.
    if (!resort && activeItemId) {
      anchorToPreviousIndex(
        bucket, activeItemId,
        view.sortedOrder.filter(e => e.tier === tier).map(e => e.id));
    }
    for (const item of bucket) ordered.push({ item, tier });
  }
  return ordered;
}

/**
 * Split the list into what is shown and what is behind the "older" toggle.
 *
 * Never returns an empty visible list: if every row would be truncated, they
 * are all shown instead — an empty sidebar reads as a broken app.
 */
function truncate(
  ordered: readonly OrderedItem[],
  activeItemId: string | null,
): { visible: OrderedItem[]; older: OrderedItem[] } {
  const visible: OrderedItem[] = [];
  const older: OrderedItem[] = [];
  const ageCutoff = Date.now() - view.sessionMaxAgeDays * 86400000;
  let count = 0;

  for (const entry of ordered) {
    const survives = rowSurvivesTruncation(entry.item, entry.tier, {
      count,
      visibleSessionCount: view.visibleSessionCount,
      ageCutoff,
      isActive: entry.item.element.id === activeItemId,
    });
    if (survives) {
      visible.push(entry);
      count++;
    } else {
      older.push(entry);
    }
  }

  if (visible.length === 0 && older.length > 0) return { visible: older, older: [] };
  return { visible, older };
}

// ── Assembling the DOM ──

function buildList(
  visible: readonly OrderedItem[],
  older: readonly OrderedItem[],
  filtering: boolean,
): HTMLElement {
  const list = document.createElement('div');
  list.className = 'session-list';
  list.id = 'session-list';

  // Section headings only make sense in the unfiltered view; a filtered list is
  // already one answer to one question.
  let lastTier: number | null = null;
  for (const { item, tier } of visible) {
    if (!filtering && tier !== lastTier) {
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
    const toggle = document.createElement('div');
    toggle.className = 'sessions-more-toggle';
    toggle.id = 'older-all';
    toggle.textContent = `+ ${older.length} older`;

    const olderList = document.createElement('div');
    olderList.className = 'sessions-older';
    olderList.id = 'older-list-all';
    olderList.style.display = 'none';
    for (const { item } of older) olderList.appendChild(item.element);

    list.append(toggle, olderList);
  }

  return list;
}

/**
 * Carry the bits of state that live in the DOM across a morph.
 *
 * A collapsed group, an expanded "older" list and a rename in progress are all
 * things the user did, and the freshly built tree knows nothing about them.
 */
function preserveInteractionState(fromEl: HTMLElement, toEl: HTMLElement): boolean {
  // A row being renamed is left entirely alone: replacing it would discard what
  // the user is typing.
  if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
    return false;
  }
  if (fromEl.classList.contains('slug-group')) {
    toEl.classList.toggle('collapsed', fromEl.classList.contains('collapsed'));
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
}

/**
 * Put focus back in the terminal after a redraw — unless the user is typing.
 *
 * The list re-renders on every status change, and stealing focus mid-keystroke
 * from the search box or a rename input would make either unusable.
 */
function restoreTerminalFocus(): void {
  const active = document.activeElement as HTMLElement | null;
  const typing = active && (
    active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
    || active.isContentEditable || active.closest('.modal-overlay'));
  if (typing) return;

  const open = view.activeSessionId ? openSessions.get(view.activeSessionId) : undefined;
  open?.terminal.focus();
}

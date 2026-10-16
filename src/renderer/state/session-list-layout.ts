/**
 * What the session list shows, and in what order: the rules, as pure
 * functions.
 *
 * One flat list across every project, never grouped by directory. Sessions
 * waiting on the user sort to the top, then the ones that finished unread, then
 * the ones still working, then pinned, then the rest — each block most recent
 * first. Sessions sharing a slug fold into a group, but only within their own
 * project.
 *
 * The list is *anchored*: the session the user is working in keeps the slot it
 * already had, so the list cannot slide out from under the cursor while the
 * rest reorders. That needs the order the list was last laid out in, which the
 * session-list slice keeps and hands back here (see `session-list-slice`).
 *
 * Nothing here reads the DOM, the store or the clock: the caller passes in
 * everything that is live (the tiers, the keys, the time), so each rule can be
 * tested in node with a plain record.
 */
import { byMostRecentlyModified } from '../../domain/session/session';
import { cleanDisplayName } from '../../domain/session/title';
import { TIER_ORDER, itemTier, rowSurvivesTruncation } from '../../domain/session/tiers';
import { formatDate, localDateKey } from '../lib/format';
import type { Project } from '../../domain/project/project';
import type { SessionRow } from '../../domain/session/session';

/** One session's row, with the copy of the session it was laid out from. */
export interface SessionListRow {
  readonly kind: 'row';
  /** `si-<local key>`: stable across a re-key, so the row keeps its element. */
  readonly id: string;
  readonly session: SessionRow;
  /** The project it is listed under; its own path when that is empty. */
  readonly projectPath: string;
}

/** Sessions sharing a slug, newest first. */
export interface SessionListGroup {
  readonly kind: 'group';
  /** See `slugId`. */
  readonly id: string;
  readonly slug: string;
  readonly projectPath: string;
  readonly sessions: readonly SessionListRow[];
}

export type SessionListEntry = SessionListRow | SessionListGroup;

/** A top-level entry, with what the ordering rules need from it. */
export interface ListItem {
  readonly entry: SessionListEntry;
  /** Epoch ms of the newest session behind this entry. */
  readonly sortTime: number;
  readonly pinned: boolean;
  /** The highest tier of its sessions, before pinning is taken into account. */
  readonly tier: number;
  readonly remote: boolean;
}

/** An entry in its final place, under the section it is filed in. */
export interface LaidEntry {
  readonly entry: SessionListEntry;
  readonly tier: number;
}

/** One entry of the full render order, the thing the next layout anchors against. */
export interface OrderedEntry {
  readonly id: string;
  readonly tier: number;
}

/** What the list shows: the visible entries, and what is behind "+ N older". */
export interface SessionListLayout {
  readonly visible: readonly LaidEntry[];
  readonly older: readonly LaidEntry[];
  /** A filter or a search is on: no section labels, and nothing folded away. */
  readonly filtering: boolean;
}

// ── Labels and ids ──

/**
 * The element id for a slug group.
 *
 * The same slug can exist in two checkouts of the same repo; they stay two
 * groups, so the project has to be part of the id.
 */
export function slugId(slug: string, projectPath: string): string {
  return 'slug-' + (projectPath + '--' + slug).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** The element id of a session's row. */
export function rowId(key: string): string {
  return 'si-' + key;
}

/** The label a session shows: its name, its AI title, or its first prompt. */
export function sessionDisplayName(session: SessionRow): string {
  return cleanDisplayName(session.name || session.aiTitle || session.summary) ?? '';
}

/** The label a slug group shows: its newest session's, falling back to the slug. */
export function groupDisplayName(group: SessionListGroup): string {
  const newest = group.sessions[0].session;
  return cleanDisplayName(newest.name || newest.aiTitle || newest.summary || group.slug) ?? '';
}

/** The name a session shows when it has no rename of its own — what a rename falls back to. */
export function fallbackName(session: SessionRow): string {
  return session.aiTitle || session.summary;
}

/** The relative time, as of `now`, plus the message count. */
export function sessionTimeLabel(session: SessionRow, now: number): string {
  const suffix = session.messageCount ? ' · ' + session.messageCount + ' msgs' : '';
  return formatDate(new Date(session.modified), now) + suffix;
}

// ── Building ──

/** The filters, as the list reads them. */
export interface ListFilters {
  readonly showArchived: boolean;
  readonly showStarredOnly: boolean;
  readonly showRunningOnly: boolean;
  readonly showTodayOnly: boolean;
}

/** The live facts building needs, handed in so building stays pure. */
export interface BuildInputs {
  readonly filters: ListFilters;
  /** Session ids with a live PTY. */
  readonly running: ReadonlySet<string>;
  readonly activeSessionId: string | null;
  /** The tier a session's own signals put it in. */
  tierOf(sessionId: string): number;
  /** A session's stable local key. */
  keyOf(sessionId: string): string;
  /** Today, as `localDateKey` spells it. */
  readonly today: string;
}

export function passesFilters(sessions: readonly SessionRow[], inputs: BuildInputs): SessionRow[] {
  const { filters } = inputs;
  let filtered = [...sessions];
  // The archive filter is the only way archived sessions surface: when it is on
  // we show exactly the archived ones, when it is off they are hidden entirely.
  if (filters.showArchived) filtered = filtered.filter(s => s.archived);
  if (filters.showStarredOnly) filtered = filtered.filter(s => s.starred);
  if (filters.showRunningOnly) filtered = filtered.filter(s => inputs.running.has(s.sessionId));
  if (filters.showTodayOnly) {
    filtered = filtered.filter(s => s.modified && localDateKey(new Date(s.modified)) === inputs.today);
  }
  return filtered;
}

/**
 * Flatten every project's sessions into one list of entries.
 *
 * Sessions sharing a slug collapse into a group, but only within their own
 * project — the same slug in two checkouts stays two groups. Each session is
 * copied, so the layout holds what the list showed at this moment, however
 * the shared row objects change afterwards.
 */
export function listItems(
  projects: readonly Project[],
  inputs: BuildInputs,
): { items: ListItem[]; activeItemId: string | null } {
  const items: ListItem[] = [];
  let activeItemId: string | null = null;

  const row = (session: SessionRow, projectPath: string): SessionListRow => ({
    kind: 'row',
    id: rowId(inputs.keyOf(session.sessionId)),
    session: { ...session },
    projectPath,
  });

  for (const project of projects) {
    const filtered = passesFilters(project.sessions, inputs);
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
      const entry = row(session, project.projectPath);
      if (session.sessionId === inputs.activeSessionId) activeItemId = entry.id;
      items.push({
        entry,
        sortTime: new Date(session.modified).getTime(),
        pinned: !!session.starred,
        tier: inputs.tierOf(session.sessionId),
        remote: session.type === 'remote',
      });
    }

    for (const [slug, sessions] of bySlug) {
      const sorted = [...sessions].sort(byMostRecentlyModified);
      const entry: SessionListEntry = sorted.length === 1
        ? row(sorted[0], project.projectPath)
        : {
          kind: 'group',
          id: slugId(slug, project.projectPath),
          slug,
          projectPath: project.projectPath,
          sessions: sorted.map(s => row(s, project.projectPath)),
        };
      if (sorted.some(s => s.sessionId === inputs.activeSessionId)) activeItemId = entry.id;
      items.push({
        entry,
        sortTime: Math.max(...sorted.map(s => new Date(s.modified).getTime())),
        pinned: sorted.some(s => !!s.starred),
        tier: Math.max(...sorted.map(s => inputs.tierOf(s.sessionId))),
        remote: sorted.some(s => s.type === 'remote'),
      });
    }
  }

  return { items, activeItemId };
}

// ── Ordering ──

/**
 * Move the anchored entry back to the index it held last time, leaving
 * everything else in its freshly sorted order.
 */
function anchorToPreviousIndex(items: ListItem[], anchorId: string, previousIds: readonly string[]): void {
  const from = items.findIndex(item => item.entry.id === anchorId);
  const to = previousIds.indexOf(anchorId);
  if (from === -1 || to === -1 || from === to) return;
  const [item] = items.splice(from, 1);
  items.splice(Math.min(to, items.length), 0, item);
}

/**
 * Sort the entries into their sections, newest first within each, with the
 * active entry anchored to its previous slot unless this is a re-sort.
 *
 * `previous` is the full order of the last layout (see `orderOf`).
 */
export function orderEntries(
  items: readonly ListItem[],
  activeItemId: string | null,
  resort: boolean,
  previous: readonly OrderedEntry[],
): LaidEntry[] {
  const buckets = new Map<number, ListItem[]>();
  for (const item of items) {
    const tier = itemTier(item);
    const bucket = buckets.get(tier);
    if (bucket) bucket.push(item);
    else buckets.set(tier, [item]);
  }

  const ordered: LaidEntry[] = [];
  for (const tier of TIER_ORDER) {
    const bucket = buckets.get(tier);
    if (!bucket) continue;
    bucket.sort((a, b) => b.sortTime - a.sortTime);
    // Anchoring only holds while the session stays in the same block: once its
    // tier changes, the slot it used to occupy belongs to another section, and
    // holding it there would file the row under the wrong heading.
    if (!resort && activeItemId) {
      anchorToPreviousIndex(bucket, activeItemId, previous.filter(e => e.tier === tier).map(e => e.id));
    }
    for (const item of bucket) ordered.push({ entry: item.entry, tier });
  }
  return ordered;
}

/** The caps truncation applies. */
export interface TruncationLimits {
  readonly visibleSessionCount: number;
  readonly sessionMaxAgeDays: number;
  /** Epoch ms the age cutoff counts back from. */
  readonly now: number;
}

/**
 * Split the list into what is shown and what is behind the "older" toggle.
 *
 * Never answers an empty visible list: if every row would be truncated, they
 * are all shown instead — an empty sidebar reads as a broken app.
 */
export function truncateEntries(
  ordered: readonly LaidEntry[],
  items: ReadonlyMap<string, ListItem>,
  activeItemId: string | null,
  { visibleSessionCount, sessionMaxAgeDays, now }: TruncationLimits,
): { visible: LaidEntry[]; older: LaidEntry[] } {
  const visible: LaidEntry[] = [];
  const older: LaidEntry[] = [];
  const ageCutoff = now - sessionMaxAgeDays * 86400000;
  let count = 0;

  for (const laid of ordered) {
    const item = items.get(laid.entry.id)!;
    const survives = rowSurvivesTruncation(item, laid.tier, {
      count,
      visibleSessionCount,
      ageCutoff,
      isActive: laid.entry.id === activeItemId,
    });
    if (survives) {
      visible.push(laid);
      count++;
    } else {
      older.push(laid);
    }
  }

  if (visible.length === 0 && older.length > 0) return { visible: older, older: [] };
  return { visible, older };
}

/** Everything one layout pass needs besides the entries. */
export interface LayoutOptions extends TruncationLimits {
  readonly activeItemId: string | null;
  readonly resort: boolean;
  readonly filtering: boolean;
}

/** Order, then truncate — except while filtering, which shows every match. */
export function layoutSessionList(
  items: readonly ListItem[],
  previous: readonly OrderedEntry[],
  options: LayoutOptions,
): { layout: SessionListLayout; order: OrderedEntry[] } {
  const ordered = orderEntries(items, options.activeItemId, options.resort, previous);
  const byId = new Map(items.map(item => [item.entry.id, item]));
  const { visible, older } = options.filtering
    ? { visible: ordered, older: [] }
    : truncateEntries(ordered, byId, options.activeItemId, options);
  return {
    layout: { visible, older, filtering: options.filtering },
    // The full order, folded rows included: a row coming back from "older"
    // anchors like any other.
    order: ordered.map(({ entry, tier }) => ({ id: entry.id, tier })),
  };
}

/** Every row of a layout, inside groups and behind "older" included. */
export function layoutRows(layout: SessionListLayout): SessionListRow[] {
  const rows: SessionListRow[] = [];
  for (const { entry } of [...layout.visible, ...layout.older]) {
    if (entry.kind === 'row') rows.push(entry);
    else rows.push(...entry.sessions);
  }
  return rows;
}

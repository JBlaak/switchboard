/**
 * One tile of the rail, and the shapes that are variations on it.
 *
 * A tile is a 32px button carrying a two-letter monogram, at most one badge,
 * and — for the project currently in scope — a stack of 24px worktree sub-tiles
 * hanging off a connector line. Everything it decides (order, badge, monogram)
 * is decided in `rail-model.ts`; this file turns those answers into elements.
 *
 * The tile is deliberately a `<button>` rather than a div: it is a control, it
 * needs to be reachable by Tab, and `aria-pressed` is how "this is the place
 * you are" is said to a screen reader — the mint bar only says it to the eye.
 */
import { ICONS } from '../../lib/icons';
import { monogramFor, railBadge } from './rail-model';
import { projectLabel } from '../sessions/project-label';
import { setScope } from '../../state/scope-store';
import type { RailBadge, RailRow } from './rail-model';
import type { Scope, Worktree } from '../../../domain/git/types';
import type { SessionSignals } from '../../../domain/session/tiers';

/** What the last `git worktree list` for a project did. */
export type WorktreeProbe =
  | { kind: 'unknown' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed'; message: string };

/** One project's tile, as the rail hands it over. */
export interface ProjectTile {
  projectPath: string;
  remote: boolean;
  /**
   * The checkouts to hang under it — empty for every tile but the scoped one,
   * and for a project with a single checkout, which has nowhere else to be.
   */
  worktrees: readonly Worktree[];
  probe: WorktreeProbe;
}

/** What every tile in one render shares. */
export interface RailContext {
  scope: Scope | null;
  /** Every session the app knows about — a tile's badge is aggregated over these. */
  rows: readonly RailRow[];
  signalsOf(sessionId: string): SessionSignals;
  worktreesFor(projectPath: string): readonly string[];
  /** Re-read this project's worktrees now, past the cache's TTL. */
  onExpand(projectPath: string): void;
  onMenu(projectPath: string, anchor: HTMLElement): void;
}

/**
 * The tile that clears the scope.
 *
 * First on the rail, and the only one that is always reachable — invariant 3:
 * nothing about the app may become unreachable because a scope is set, and this
 * is the way back to the flat cross-project list.
 */
export function buildAllTile(ctx: RailContext): HTMLElement {
  const group = document.createElement('div');
  group.className = 'rail-group';
  if (ctx.scope === null) group.classList.add('is-scoped');

  const tile = tileButton('', 'All projects');
  tile.classList.add('rail-tile-all');
  tile.setAttribute('aria-pressed', String(ctx.scope === null));
  tile.innerHTML = ICONS.folder(16);
  tile.onclick = () => setScope(null);
  paintBadge(tile, railBadge(ctx.rows, ctx.signalsOf, null, ctx.scope, ctx.worktreesFor));

  group.appendChild(tile);
  return group;
}

/**
 * A project's tile, plus its worktree sub-tiles when it is the one in scope.
 *
 * The group is what carries the scope marking, not the tile: the mint bar sits
 * at the rail's own left edge rather than the tile's, and the sub-tiles have to
 * hang inside the same box as the connector that ties them to it.
 */
export function buildProjectTile(project: ProjectTile, ctx: RailContext): HTMLElement {
  const { scope } = ctx;
  const scoped = scope !== null && scope.projectPath === project.projectPath;

  const group = document.createElement('div');
  group.className = 'rail-group';
  group.dataset.projectPath = project.projectPath;
  if (scoped) group.classList.add('is-scoped');

  const tile = tileButton(monogramFor(project.projectPath), tooltipFor(project, ctx));
  if (project.remote) tile.classList.add('is-remote');
  if (project.probe.kind === 'failed') tile.classList.add('is-unreachable');
  tile.setAttribute('aria-pressed', String(scope !== null
    && scope.projectPath === project.projectPath && scope.worktreePath === null));
  tile.onclick = () => {
    // Idempotent in the store, so clicking the tile you are already on costs
    // nothing — which makes it the natural gesture for "look again", and the
    // only explicit re-read of the worktree list the rail offers.
    if (scoped) ctx.onExpand(project.projectPath);
    setScope({ projectPath: project.projectPath, worktreePath: null });
  };
  tile.oncontextmenu = (e: MouseEvent) => {
    e.preventDefault();
    ctx.onMenu(project.projectPath, tile);
  };
  paintBadge(tile, railBadge(
    ctx.rows, ctx.signalsOf,
    { projectPath: project.projectPath, worktreePath: null },
    scope, ctx.worktreesFor,
  ));

  group.appendChild(tile);
  if (project.worktrees.length > 1) group.appendChild(buildWorktrees(project, ctx));
  return group;
}

/**
 * The checkouts of the scoped project, on their connector.
 *
 * Every entry is drawn, the primary included. Invariant 5: two checkouts of one
 * repo must never read as one place — and if the primary had no sub-tile of its
 * own there would be no way to narrow to it alone, only to the repo as a whole.
 */
function buildWorktrees(project: ProjectTile, ctx: RailContext): HTMLElement {
  const list = document.createElement('div');
  list.className = 'rail-worktrees';

  for (const worktree of project.worktrees) {
    const label = worktree.branch ?? (worktree.detached ? worktree.head.slice(0, 7) : worktree.path);
    const selected = ctx.scope !== null
      && ctx.scope.projectPath === project.projectPath
      && ctx.scope.worktreePath === worktree.path;

    const tile = tileButton(monogramFor(label), worktreeTooltip(worktree, label));
    tile.classList.add('rail-subtile');
    if (worktree.isPrimary) tile.classList.add('is-primary');
    if (selected) tile.classList.add('is-selected');
    tile.setAttribute('aria-pressed', String(selected));
    tile.onclick = () => setScope({
      projectPath: project.projectPath,
      worktreePath: worktree.path,
    });
    tile.oncontextmenu = (e: MouseEvent) => {
      e.preventDefault();
      ctx.onMenu(project.projectPath, tile);
    };
    paintBadge(tile, railBadge(
      ctx.rows, ctx.signalsOf,
      { projectPath: project.projectPath, worktreePath: worktree.path },
      ctx.scope, ctx.worktreesFor,
    ));

    list.appendChild(tile);
  }
  return list;
}

/**
 * The dashed `+N` tile, and the flyout it opens.
 *
 * The rail does not scroll, so on a short window the tiles that do not fit go
 * behind this one — with their badges intact, because a project going quiet
 * just because the window got shorter is the failure invariant 4 is about.
 */
export function buildOverflowTile(hidden: readonly ProjectTile[], ctx: RailContext): HTMLElement {
  const group = document.createElement('div');
  group.className = 'rail-group';

  const tile = tileButton('+' + hidden.length, `${hidden.length} more project${hidden.length > 1 ? 's' : ''}`);
  tile.classList.add('rail-tile-overflow');
  tile.onclick = () => openFlyout(hidden, ctx, tile);
  paintBadge(tile, badgeAcross(hidden, ctx));

  group.appendChild(tile);
  return group;
}

/** The most urgent thing any hidden project is saying. */
function badgeAcross(projects: readonly ProjectTile[], ctx: RailContext): RailBadge {
  const badges = projects.map(project => railBadge(
    ctx.rows, ctx.signalsOf,
    { projectPath: project.projectPath, worktreePath: null },
    ctx.scope, ctx.worktreesFor,
  ));
  if (badges.includes('waiting')) return 'waiting';
  if (badges.includes('unread')) return 'unread';
  return badges.includes('running') ? 'running' : null;
}

/**
 * The hidden tiles, listed beside the rail.
 *
 * A list rather than a continuation of the column: there is room for the labels
 * here, and a project you cannot see the monogram of every day is one you need
 * the name of. Dismissed the way the app's other popovers are.
 */
function openFlyout(hidden: readonly ProjectTile[], ctx: RailContext, anchor: HTMLElement): void {
  document.querySelectorAll<HTMLElement>('.rail-flyout').forEach(el => el.remove());

  const flyout = document.createElement('div');
  flyout.className = 'rail-flyout';

  const close = (): void => {
    flyout.remove();
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('keydown', onKey);
  };
  const onMouseDown = (e: MouseEvent): void => {
    if (flyout.contains(e.target as Node) || e.target === anchor) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  };

  for (const project of hidden) {
    const row = document.createElement('button');
    row.className = 'rail-flyout-row';
    row.type = 'button';

    // A span, not a `tileButton`: the row itself is the button and HTML has no
    // nested ones. It carries the tile's classes so the badge and the remote
    // tint come out identical to the rail's.
    const tile = document.createElement('span');
    tile.className = 'rail-tile';
    tile.textContent = monogramFor(project.projectPath);
    if (project.remote) tile.classList.add('is-remote');
    paintBadge(tile, railBadge(
      ctx.rows, ctx.signalsOf,
      { projectPath: project.projectPath, worktreePath: null },
      ctx.scope, ctx.worktreesFor,
    ));

    const label = document.createElement('span');
    label.className = 'rail-flyout-label';
    label.textContent = projectLabel(project.projectPath);

    row.append(tile, label);
    row.onclick = () => {
      close();
      setScope({ projectPath: project.projectPath, worktreePath: null });
    };
    row.oncontextmenu = (e: MouseEvent) => {
      e.preventDefault();
      close();
      ctx.onMenu(project.projectPath, row);
    };
    flyout.appendChild(row);
  }

  document.body.appendChild(flyout);
  const rect = anchor.getBoundingClientRect();
  const height = flyout.offsetHeight;
  flyout.style.left = rect.right + 6 + 'px';
  flyout.style.top = Math.max(6, Math.min(rect.top, window.innerHeight - height - 6)) + 'px';

  // Deferred: the click that opened this is still propagating.
  setTimeout(() => document.addEventListener('mousedown', onMouseDown), 0);
  document.addEventListener('keydown', onKey);
}

/** The bare 32px button every shape above starts from. */
function tileButton(text: string, tooltip: string): HTMLButtonElement {
  const tile = document.createElement('button');
  tile.className = 'rail-tile';
  tile.type = 'button';
  tile.textContent = text;
  if (tooltip) tile.title = tooltip;
  return tile;
}

/**
 * At most one dot.
 *
 * Precedence is settled in `railBadge`; this only paints. The waiting dot also
 * rings its tile, which is the one state worth catching out of the corner of an
 * eye — a session is stalled until someone answers it.
 */
function paintBadge(tile: HTMLElement, badge: RailBadge): void {
  if (badge === null) return;
  tile.classList.add('badge-' + badge);
  const dot = document.createElement('span');
  dot.className = 'rail-badge';
  tile.appendChild(dot);
}

function tooltipFor(project: ProjectTile, ctx: RailContext): string {
  const lines = [projectLabel(project.projectPath)];
  if (project.probe.kind === 'failed') {
    // Never "no worktrees": for an ssh:// project a failure is almost always an
    // unreachable host or a refused key, and reporting that as a repository
    // with one checkout would be a lie the user acts on.
    lines.push(project.remote ? 'Can’t reach host' : 'Couldn’t read worktrees');
    lines.push(project.probe.message);
  } else if (project.probe.kind === 'loading') {
    lines.push('Reading worktrees…');
  } else if (project.worktrees.length > 1) {
    lines.push(`${project.worktrees.length} checkouts`);
  }
  if (ctx.scope !== null && ctx.scope.projectPath === project.projectPath) lines.push('In scope');
  return lines.join('\n');
}

function worktreeTooltip(worktree: Worktree, label: string): string {
  const lines = [label];
  if (worktree.isPrimary) lines.push('Primary checkout');
  if (worktree.locked !== undefined) lines.push('Locked' + (worktree.locked ? ': ' + worktree.locked : ''));
  lines.push(worktree.path);
  return lines.join('\n');
}

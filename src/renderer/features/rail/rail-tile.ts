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
import { monogramFor, railBadge, worktreeLabel, worktreeMonograms } from './rail-model';
import { projectLabel } from '../sessions/project-label';
import { setScope } from '../../state/scope-store';
import { showMissingWorktreeMenu } from './rail-menu';
import type { RailBadge, RailRow } from './rail-model';
import type { Scope, Worktree } from '../../../domain/git/types';
import type { SessionSignals } from '../../../domain/session/tiers';

/**
 * What the last `git worktree list` for a project did.
 *
 * `no-repo` is its own answer rather than a `ready` with nothing in it, because
 * the two mean opposite things to a reader: a repository always has at least
 * its main working tree, so an empty list can only be git saying "there is no
 * repository here". The rail's whole promise is that a project is a place with
 * a branch and a diff, and this is the case where that is not true — so it has
 * to be said rather than left to look like an ordinary tile.
 */
export type WorktreeProbe =
  | { kind: 'unknown' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'no-repo' }
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
  /** The main working tree's branch, or null when detached or not a repository. */
  branch: string | null;
  /** The main working tree is detached; `branch` is null and `head` is what it is at. */
  detached: boolean;
  /** The short head of the main working tree, for a detached one. */
  head: string;
  /**
   * A checkout the scope names that `git worktree list` no longer reports —
   * the directory was deleted from under it. Kept as a tile of its own rather
   * than dropped: its sessions and their transcripts still exist, and silently
   * losing the tile loses the way back to them.
   */
  missingWorktree: string | null;
  /**
   * Checkouts past what the rail has height for, behind the stack's own `+N`.
   *
   * The rail does not scroll, and a repository can have many more checkouts
   * than a stack has room for — an agent swarm leaves one per agent. They are
   * listed rather than dropped: a checkout you cannot reach is a scope you
   * cannot get back to.
   */
  hiddenWorktrees: readonly Worktree[];
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
  if (project.probe.kind === 'no-repo') tile.classList.add('is-no-repo');
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
  // A single checkout has nowhere else to be, so it draws no stack — unless the
  // scope names one that has since been deleted, which has to be reachable.
  if (project.worktrees.length > 1 || project.missingWorktree !== null) {
    group.appendChild(buildWorktrees(project, ctx));
  }
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

  // Monogrammed as a set, not one at a time: the checkouts of one repository
  // are named to look alike, and the whole point of a sub-tile is to be
  // distinguishable from its neighbours. See `worktreeMonograms`.
  const monograms = worktreeMonograms(project.worktrees);

  project.worktrees.forEach((worktree, index) => {
    const label = worktreeLabel(worktree);
    const selected = ctx.scope !== null
      && ctx.scope.projectPath === project.projectPath
      && ctx.scope.worktreePath === worktree.path;

    const tile = tileButton(monograms[index], worktreeTooltip(worktree, label));
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
  });

  if (project.missingWorktree !== null) {
    list.appendChild(missingSubtile(project, project.missingWorktree, ctx));
  }
  if (project.hiddenWorktrees.length > 0) {
    list.appendChild(moreWorktreesSubtile(project, ctx));
  }
  return list;
}

/**
 * The checkouts the stack had no height for, behind one `+N` sub-tile.
 *
 * The same answer the project column gives when it runs out of room, one level
 * down, and for the same reason: the rail does not scroll, and a checkout that
 * is merely off the bottom is a scope nobody can return to. Its badge is the
 * most urgent thing any of them is saying, so invariant 4 survives the fold.
 */
function moreWorktreesSubtile(project: ProjectTile, ctx: RailContext): HTMLButtonElement {
  const hidden = project.hiddenWorktrees;
  const tile = tileButton(
    '+' + hidden.length,
    `${hidden.length} more checkout${hidden.length > 1 ? 's' : ''}`,
  );
  tile.classList.add('rail-subtile', 'rail-tile-overflow');
  tile.onclick = () => openWorktreeFlyout(project, hidden, ctx, tile);

  const badges = hidden.map(worktree => railBadge(
    ctx.rows, ctx.signalsOf,
    { projectPath: project.projectPath, worktreePath: worktree.path },
    ctx.scope, ctx.worktreesFor,
  ));
  paintBadge(tile, badges.includes('waiting') ? 'waiting'
    : badges.includes('unread') ? 'unread'
      : badges.includes('running') ? 'running' : null);
  return tile;
}

/** The hidden checkouts, listed beside the rail with room for their names. */
function openWorktreeFlyout(
  project: ProjectTile, hidden: readonly Worktree[], ctx: RailContext, anchor: HTMLElement,
): void {
  const { flyout, close } = flyoutShell(anchor);
  const monograms = worktreeMonograms(hidden);

  hidden.forEach((worktree, index) => {
    const label = worktreeLabel(worktree);
    const row = document.createElement('button');
    row.className = 'rail-flyout-row';
    row.type = 'button';
    row.title = worktreeTooltip(worktree, label);

    const tile = document.createElement('span');
    tile.className = 'rail-tile rail-subtile';
    tile.textContent = monograms[index];
    paintBadge(tile, railBadge(
      ctx.rows, ctx.signalsOf,
      { projectPath: project.projectPath, worktreePath: worktree.path },
      ctx.scope, ctx.worktreesFor,
    ));

    const name = document.createElement('span');
    name.className = 'rail-flyout-label';
    name.textContent = label;

    row.append(tile, name);
    row.onclick = () => {
      close();
      setScope({ projectPath: project.projectPath, worktreePath: worktree.path });
    };
    flyout.appendChild(row);
  });

  place(flyout, anchor);
}

/**
 * The checkout that is no longer on disk.
 *
 * Dashed and dimmed, and still the scope — because it still is: the sessions
 * that ran in it are in the list underneath, and their transcripts are where
 * they always were. Clicking it offers the only two things left to do with it,
 * `Forget` and `Recreate`, rather than scoping to it again (it is already the
 * scope) or doing nothing (which reads as a broken tile).
 */
function missingSubtile(project: ProjectTile, path: string, ctx: RailContext): HTMLButtonElement {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const tile = tileButton(
    monogramFor(path),
    ['Worktree removed', name, path].join('\n'),
  );
  tile.classList.add('rail-subtile', 'is-missing');
  // The scope still names it, so it is still the place the user is in.
  tile.setAttribute('aria-pressed', 'true');
  const open = (): void => showMissingWorktreeMenu(project.projectPath, path, tile);
  tile.onclick = open;
  tile.oncontextmenu = (e: MouseEvent) => {
    e.preventDefault();
    open();
  };
  paintBadge(tile, railBadge(
    ctx.rows, ctx.signalsOf,
    { projectPath: project.projectPath, worktreePath: path },
    ctx.scope, ctx.worktreesFor,
  ));
  return tile;
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
  const { flyout, close } = flyoutShell(anchor);

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

  place(flyout, anchor);
}

/**
 * An empty flyout beside the rail, and the way to shut it.
 *
 * Shared by the two overflows — projects that did not fit the column, and
 * checkouts that did not fit a stack — so both dismiss on the same gestures.
 * Only one is ever open: opening either clears whatever was there.
 */
function flyoutShell(anchor: HTMLElement): { flyout: HTMLElement; close: () => void } {
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

  // Deferred: the click that opened this is still propagating.
  setTimeout(() => document.addEventListener('mousedown', onMouseDown), 0);
  document.addEventListener('keydown', onKey);
  return { flyout, close };
}

/** Beside its anchor, and never off the top or bottom of the window. */
function place(flyout: HTMLElement, anchor: HTMLElement): void {
  document.body.appendChild(flyout);
  const rect = anchor.getBoundingClientRect();
  const height = flyout.offsetHeight;
  flyout.style.left = rect.right + 6 + 'px';
  flyout.style.top = Math.max(6, Math.min(rect.top, window.innerHeight - height - 6)) + 'px';
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

/**
 * What the tile says on hover.
 *
 * The branch line is the point of it. A tile with nothing but a name on it
 * reads as "a project, therefore a repository, therefore a branch and a diff" —
 * so a place that has a branch names it, and a place that has none says so
 * instead of staying quiet and letting the promise stand.
 */
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
  } else if (project.probe.kind === 'no-repo') {
    lines.push('No repository — files only');
  } else if (project.probe.kind === 'ready') {
    if (project.branch !== null) lines.push('⎇ ' + project.branch);
    else if (project.detached) lines.push('detached at ' + project.head.slice(0, 7));
    const count = project.worktrees.length + (project.missingWorktree === null ? 0 : 1);
    if (count > 1) lines.push(`${count} checkouts`);
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

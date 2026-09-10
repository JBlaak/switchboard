/**
 * The project rail: a 48px column of tiles that says where you are.
 *
 * Left of the sidebar, and the only control over the scope — clicking a tile
 * narrows the session list to that project, clicking a worktree sub-tile
 * narrows it to that checkout, and the `All` tile at the top clears it. The
 * rail owns none of the filtering: it writes to `scope-store` and the sidebar
 * reads from it, which is what keeps "which place am I in" a single fact rather
 * than two surfaces agreeing to disagree.
 *
 * Three things about the render are load-bearing.
 *
 * **It coalesces.** The rail keys off three events and two of them are noisy:
 * `onSidebarRefresh` fires on every busy flip and `onActivityChange(null)` on
 * every three-second poll. Each of those would otherwise rebuild the column,
 * so they all go through one `requestAnimationFrame`.
 *
 * **It compares before it replaces.** Even coalesced, a poll that changed
 * nothing would still tear down and rebuild every tile — losing hover, focus
 * and any tooltip the user was reading. So the render derives a signature from
 * everything it reads and does nothing when it matches the last one.
 *
 * **It never fetches from a refresh listener.** `git worktree list` is a
 * process (an ssh round trip for a remote project), and a refresh happens
 * several times a second under load. Worktrees are read when a project becomes
 * the scope, cached per path with a TTL, and pushed into `scope-store` for the
 * filter to use — see `readWorktrees`.
 */
import {
  RAIL_DIVIDER_PX, RAIL_GAP_PX, RAIL_SUBTILE_PX, RAIL_TILE_PX,
  orderRailProjects, splitForRail,
} from './rail-model';
import { absorbedProjectPaths } from '../../../domain/git/scope';
import { buildAllTile, buildOverflowTile, buildProjectTile } from './rail-tile';
import { getScope, knownWorktreesFor, onScopeChange, setKnownWorktrees } from '../../state/scope-store';
import { onActivityChange, signalsFor } from '../../state/activity-store';
import { onSidebarRefresh } from '../../app/refresh';
import { projectRail } from '../../lib/dom';
import { showAddProjectDialog } from '../dialogs/add-project-dialog';
import { showRailMenu } from './rail-menu';
import { view } from '../../state/session-store';
import type { ProjectTile, RailContext, WorktreeProbe } from './rail-tile';
import type { RailRow } from './rail-model';
import type { Project } from '../../../domain/project/project';
import type { Scope, Worktree } from '../../../domain/git/types';

/**
 * How long a worktree read is trusted.
 *
 * Short enough that a `git worktree add` in a terminal shows up on the rail
 * within a scope change or two, long enough that sitting in one project does
 * not spawn a git process every poll. A failure is trusted for much longer: the
 * usual failure is an ssh host that is off or behind a VPN, and re-dialling it
 * every thirty seconds means a thirty-second timeout permanently in flight.
 */
const WORKTREE_TTL_MS = 30_000;
const WORKTREE_FAILURE_TTL_MS = 5 * 60_000;

interface Probe {
  /** When this answer was recorded, for the TTL. */
  at: number;
  worktrees: readonly Worktree[];
  state: WorktreeProbe['kind'];
  message: string;
}

/** projectPath, exactly as the project list spells it → its last worktree read. */
const probes = new Map<string, Probe>();

let frame = 0;
let lastSignature = '';

/**
 * Wire the rail up. Does not draw: at install time the project list is still
 * empty, so the first paint belongs in bootstrap's `loadProjects()` chain.
 */
export function installProjectRail(): void {
  onScopeChange(() => refreshProjectRail());
  onActivityChange(() => refreshProjectRail());
  onSidebarRefresh(() => refreshProjectRail());
  // How many tiles fit is a function of the window's height, so a resize can
  // change the rail without anything about the projects changing.
  window.addEventListener('resize', () => refreshProjectRail());
}

/** Redraw at most once per frame, however many callers ask. */
export function refreshProjectRail(): void {
  if (frame !== 0) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function render(): void {
  const scope = getScope();
  const projects = view.cachedAllProjects;

  // Only the scoped project's worktrees are read, and only from here — this is
  // the one code path that runs on a scope change rather than on a refresh.
  if (scope !== null) readWorktrees(scope.projectPath, false);

  const absorbed = absorbedProjectPaths(
    projects.map(project => project.projectPath), worktreeLists(projects));
  const ordered = orderRailProjects(projects, absorbed);
  const tiles = ordered.map(project => toTile(project, scope));

  const rows: RailRow[] = [];
  for (const project of projects) rows.push(...project.sessions);

  const budget = projectTileBudget(tiles.some(tile => tile.remote));
  const { shown, hidden } = budget === null
    ? { shown: tiles, hidden: [] as ProjectTile[] }
    : splitForRail(tiles, tileCost, budget);

  const signature = signatureOf(scope, shown, hidden, rows);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const context: RailContext = {
    scope,
    rows,
    signalsOf: signalsFor,
    worktreesFor: knownWorktreesFor,
    onExpand: projectPath => readWorktrees(projectPath, true),
    onMenu: showRailMenu,
  };

  const column = document.createDocumentFragment();
  column.appendChild(buildAllTile(context));
  column.appendChild(divider());

  let remoteDividerDrawn = false;
  for (const tile of shown) {
    // One divider where the local projects end, so a remote project reads as
    // somewhere else rather than as the least recently used local one.
    if (tile.remote && !remoteDividerDrawn) {
      column.appendChild(divider());
      remoteDividerDrawn = true;
    }
    column.appendChild(buildProjectTile(tile, context));
  }
  if (hidden.length > 0) column.appendChild(buildOverflowTile(hidden, context));
  column.appendChild(addProjectButton());

  projectRail.replaceChildren(column);
}

/**
 * The tile for one project, with its checkouts if it is the one in scope.
 *
 * Only the scoped project gets sub-tiles: they are places to go, and offering
 * every project's checkouts at once would be a rail of thirty tiles for a
 * machine with ten repositories. It is also the only project whose worktrees
 * have been read at all.
 */
function toTile(project: Project, scope: Scope | null): ProjectTile {
  const scoped = scope !== null && scope.projectPath === project.projectPath;
  const local = project.remote !== true;
  const probe = probes.get(project.projectPath);
  const known = probe?.worktrees ?? [];
  // The main working tree, which is what the tile itself stands for. Read off
  // the probe rather than off `worktrees` below, so a remote project — whose
  // checkouts are never drawn — still knows its own branch.
  const primary = known.find(worktree => worktree.isPrimary) ?? known[0];

  return {
    projectPath: project.projectPath,
    remote: !local,
    // A remote worktree's path is a path on the far host, so it can never match
    // a remote session's place — those rows carry no cwd at all. Sub-tiles for
    // one would scope the list to nothing, so a remote project gets its tile
    // and its reachability state and no checkouts until there is something to
    // match them against.
    worktrees: scoped && local ? known : [],
    branch: primary?.branch ?? null,
    detached: primary?.detached === true,
    head: primary?.head ?? '',
    missingWorktree: scoped && local ? missingWorktree(scope, probe) : null,
    probe: toProbeState(probe),
  };
}

/**
 * The checkout the scope names that git no longer reports, if there is one.
 *
 * Only once a list is actually in hand: while the probe is loading, or has
 * failed, or has never run, "not in the list" says nothing at all — and
 * flashing a *removed* tile at every scope change would be worse than the
 * silence it replaces.
 */
function missingWorktree(scope: Scope | null, probe: Probe | undefined): string | null {
  if (scope === null || scope.worktreePath === null) return null;
  if (probe === undefined || (probe.state !== 'ready' && probe.state !== 'no-repo')) return null;
  const path = scope.worktreePath;
  return probe.worktrees.some(worktree => worktree.path === path) ? null : path;
}

function toProbeState(probe: Probe | undefined): WorktreeProbe {
  if (!probe) return { kind: 'unknown' };
  if (probe.state === 'failed') return { kind: 'failed', message: probe.message };
  if (probe.state === 'loading') return { kind: 'loading' };
  if (probe.state === 'no-repo') return { kind: 'no-repo' };
  return { kind: 'ready' };
}

/**
 * Read a project's worktrees, unless a fresh enough answer is already in hand.
 *
 * `force` is the explicit re-read — clicking the tile you are already scoped
 * to — which is the only way past the TTL. What comes back goes to
 * `setKnownWorktrees` in git's own order, primary first, because
 * `absorbedProjectPaths` reads the first entry as the main working tree; and
 * keyed on the projectPath as the project list spells it, because that is the
 * key the filter will look it up under.
 *
 * The result may be the IPC error envelope rather than an array — every invoke
 * can answer that way — and the two failure modes read very differently to a
 * user: `[]` is a folder that is not a repository, which is a perfectly normal
 * project, while an envelope for an `ssh://` project is almost always a host
 * that cannot be reached. So a failure is recorded as one and shown as one.
 */
function readWorktrees(projectPath: string, force: boolean): void {
  const existing = probes.get(projectPath);
  if (existing?.state === 'loading') return;
  if (!force && existing) {
    const ttl = existing.state === 'failed' ? WORKTREE_FAILURE_TTL_MS : WORKTREE_TTL_MS;
    if (Date.now() - existing.at < ttl) return;
  }

  probes.set(projectPath, {
    at: Date.now(), worktrees: existing?.worktrees ?? [], state: 'loading', message: '',
  });

  const record = (probe: Probe): void => {
    probes.set(projectPath, probe);
    // The store only announces a list that changed the scoped project's, so the
    // rail asks for its own redraw either way — the tile's loading state has to
    // clear even when the answer is the one it already had.
    refreshProjectRail();
  };

  void window.api.gitWorktrees(projectPath).then(
    (answer: unknown) => {
      if (!Array.isArray(answer)) {
        const error = (answer as { error?: string } | null)?.error;
        record({ at: Date.now(), worktrees: [], state: 'failed', message: error ?? 'git failed' });
        return;
      }
      const worktrees = answer as Worktree[];
      setKnownWorktrees(projectPath, worktrees.map(worktree => worktree.path));
      // A repository always reports at least its main working tree, so an empty
      // list is git's exit 128 — this folder is not a repository at all. Kept
      // apart from `ready` so the tile can say so instead of looking like a
      // repository with one quiet checkout.
      record({
        at: Date.now(),
        worktrees,
        state: worktrees.length === 0 ? 'no-repo' : 'ready',
        message: '',
      });
    },
    (err: unknown) => {
      record({
        at: Date.now(), worktrees: [], state: 'failed', message: (err as Error).message ?? String(err),
      });
    },
  );
}

/**
 * What every project's worktrees are known to be, for the absorption test.
 *
 * Empty for every project the rail has not been scoped to yet, which is why a
 * plain `git worktree add ../feature` checkout keeps a tile of its own until
 * its parent has been visited once. The alternative is running git for every
 * project on startup, which is the fetch-from-a-refresh this module exists to
 * avoid; the `.claude/worktrees` shape — the flavour Claude CLI creates, and so
 * the common one — is recognised from the path alone and needs no list.
 */
function worktreeLists(projects: readonly Project[]): Map<string, readonly string[]> {
  const lists = new Map<string, readonly string[]>();
  for (const project of projects) {
    const known = knownWorktreesFor(project.projectPath);
    if (known.length > 0) lists.set(project.projectPath, known);
  }
  return lists;
}

/**
 * A project group's height, gap above it included.
 *
 * Mirrors what `_rail.scss` lays out: the tile, then — for the scoped project
 * with more than one checkout — the connector stack under it. A single-checkout
 * project draws no sub-tiles, so it costs no more than any other tile.
 */
function tileCost(tile: ProjectTile): number {
  const ghost = tile.missingWorktree === null ? 0 : 1;
  const drawn = tile.worktrees.length + ghost;
  const subtiles = drawn > 1 ? drawn : 0;
  const stack = subtiles === 0
    ? 0
    : RAIL_GAP_PX + subtiles * RAIL_SUBTILE_PX + (subtiles - 1) * RAIL_GAP_PX;
  return RAIL_GAP_PX + RAIL_TILE_PX + stack;
}

/**
 * The height left for project tiles, or null when the rail has not been laid
 * out yet and nothing can be measured.
 *
 * The rail does not scroll, so the arithmetic has to be done rather than left
 * to overflow: the All tile, the two dividers and the add button are fixed
 * furniture and come off the top before the projects get their share. The
 * remote divider is reserved whenever any remote project exists, even if it
 * ends up behind the overflow tile — one tile's worth of pessimism, against
 * having to solve the split and the divider for each other.
 */
function projectTileBudget(hasRemote: boolean): number | null {
  const height = projectRail.clientHeight;
  if (height <= 0) return null;

  const style = getComputedStyle(projectRail);
  const padding = parseFloat(style.paddingBlockStart) + parseFloat(style.paddingBlockEnd);
  const fixed = RAIL_TILE_PX                                    // the All tile
    + (RAIL_GAP_PX + RAIL_DIVIDER_PX)                           // the divider under it
    + (RAIL_GAP_PX + RAIL_TILE_PX)                              // the add-project button
    + (hasRemote ? RAIL_GAP_PX + RAIL_DIVIDER_PX : 0);
  return height - (Number.isFinite(padding) ? padding : 0) - fixed;
}

/**
 * Everything this render read, as one string.
 *
 * The activity poll asks for a redraw every three seconds whether or not
 * anything moved, and rebuilding the column costs the user their hover and
 * their focus. Comparing the inputs is enough: equal inputs draw equal tiles.
 */
function signatureOf(
  scope: Scope | null,
  shown: readonly ProjectTile[],
  hidden: readonly ProjectTile[],
  rows: readonly RailRow[],
): string {
  const parts: string[] = [scope === null ? 'all' : scope.projectPath + '|' + scope.worktreePath];
  for (const group of [shown, hidden]) {
    parts.push('/');
    for (const tile of group) {
      parts.push([
        tile.projectPath,
        tile.remote ? 'r' : 'l',
        tile.probe.kind,
        tile.branch ?? (tile.detached ? tile.head : ''),
        tile.missingWorktree ?? '',
        tile.worktrees.map(worktree => worktree.path).join(','),
      ].join('|'));
    }
  }
  for (const row of rows) {
    const signals = signalsFor(row.sessionId);
    if (!signals.needsAttention && !signals.responseReady && !signals.hasLivePty) continue;
    parts.push(row.sessionId
      + (signals.needsAttention ? 'a' : '')
      + (signals.responseReady ? 'u' : '')
      + (signals.hasLivePty ? 'p' : ''));
  }
  return parts.join(';');
}

function divider(): HTMLElement {
  const rule = document.createElement('div');
  rule.className = 'rail-divider';
  return rule;
}

function addProjectButton(): HTMLElement {
  const button = document.createElement('button');
  button.className = 'rail-tile rail-add-btn';
  button.type = 'button';
  button.title = 'Add project';
  button.textContent = '+';
  button.onclick = () => showAddProjectDialog();
  return button;
}

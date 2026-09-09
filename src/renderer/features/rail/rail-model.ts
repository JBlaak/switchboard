/**
 * The rail's rules, with no DOM in them.
 *
 * Which tiles exist and in what order, what each one's monogram reads as, which
 * badge it wears, and where the column runs out of room. All of it is decided
 * here so it can be tested by calling a function — the rail itself is a few
 * hundred lines of element building, and there is no jsdom in this repo to put
 * that under test. `project-rail.ts` and `rail-tile.ts` do the drawing and
 * nothing else that is worth asserting on.
 *
 * Kept free of `../../lib/dom` on purpose: that module resolves every element
 * handle at import, so anything that reaches it cannot be imported by a test.
 */
import { attributeToScope } from '../../../domain/git/scope';
import type { Scope } from '../../../domain/git/types';
import type { SessionSignals } from '../../../domain/session/tiers';

/**
 * Rail geometry, in px, duplicated from `_rail.scss`.
 *
 * The overflow split is arithmetic — how many tiles fit in the height the rail
 * has left — so the numbers have to exist in JavaScript too. The stylesheet is
 * the one the user sees; these must be kept equal to it, which is why they are
 * named rather than inlined at the two call sites.
 */
export const RAIL_TILE_PX = 32;
export const RAIL_SUBTILE_PX = 24;
export const RAIL_GAP_PX = 6;
export const RAIL_DIVIDER_PX = 1;

/**
 * What a tile is saying, at most one thing at a time.
 *
 * `waiting` is a session blocked on the user, `unread` one that finished a turn
 * nobody has read, `running` one with a live PTY. A tile with several sessions
 * in several states shows the most urgent of them: a project where one session
 * is asking a question and three others are churning wants to be read as
 * "asking a question".
 */
export type RailBadge = 'waiting' | 'unread' | 'running' | null;

/** A session, as the rail's badge arithmetic reads one. */
export interface RailRow {
  sessionId: string;
  projectPath: string;
  cwd?: string | null;
}

/** A project, as the rail's ordering reads one. */
export interface RailProject {
  projectPath: string;
  remote?: boolean;
  sessions: readonly { modified: string }[];
}

/**
 * The one badge a set of sessions earns.
 *
 * Precedence: waiting > unread > running. Ordered by what it costs the user to
 * miss it — a blocked session is stalled until they look, an unread answer is
 * only waiting to be read, and a running one needs nothing at all.
 */
export function badgeFor(signals: Iterable<SessionSignals>): RailBadge {
  let unread = false;
  let running = false;
  for (const signal of signals) {
    if (signal.needsAttention) return 'waiting';
    if (signal.responseReady) unread = true;
    if (signal.hasLivePty) running = true;
  }
  if (unread) return 'unread';
  return running ? 'running' : null;
}

/**
 * The badge one tile wears, given every session the app knows about.
 *
 * Two rules, both from the design's invariant 4 ("nothing goes quiet"):
 *
 *  - A tile speaks for every session in its place, which for a project tile
 *    includes each of its worktrees — so a worktree that needs input badges its
 *    parent. That is exactly what a scope admits, so the tile is passed as one
 *    (`{ projectPath, worktreePath: null }` for a project, the checkout's path
 *    for a sub-tile) and attribution is asked.
 *  - A tile says nothing about what the user is already looking at. Badges
 *    exist to report the places off screen; the scoped tile reporting its own
 *    sessions back would mean a permanent amber dot on the project you are
 *    working in. So a row inside the current scope is skipped — which also
 *    gives the parent tile the right answer when a *worktree* is scoped: it
 *    keeps badging the project's other checkouts and drops that one.
 *
 * Every row in the app is passed, not just the tile's project's, because a
 * plain `git worktree add ../x` checkout is still its own entry in the project
 * list (absorbed off the rail, see `absorbedProjectPaths`) and its sessions
 * belong to the parent's tile.
 *
 * A null `tile` is the All tile, which speaks for the whole app: with no scope
 * set that is everything on screen and so nothing to report, and with one set
 * it is exactly what the scope is hiding.
 */
export function railBadge(
  rows: Iterable<RailRow>,
  signalsOf: (sessionId: string) => SessionSignals,
  tile: Scope | null,
  scope: Scope | null,
  worktreesFor: (projectPath: string) => readonly string[],
): RailBadge {
  // The All tile with no scope set: the whole app is on screen, so there is
  // nothing off it to report. Stated here rather than falling out of the loop,
  // where "in the current scope" is what silences a row and a null scope
  // silences none of them.
  if (tile === null && scope === null) return null;

  const mine: SessionSignals[] = [];
  for (const row of rows) {
    if (tile !== null && !attributeToScope(row, tile, worktreesFor(tile.projectPath))) continue;
    // A null scope admits everything, which would silence the whole rail.
    if (scope !== null && attributeToScope(row, scope, worktreesFor(scope.projectPath))) continue;
    mine.push(signalsOf(row.sessionId));
  }
  return badgeFor(mine);
}

/**
 * The directory name a project is known by.
 *
 * A remote project has no local last segment to take: `ssh://user@host/dev/app`
 * is known by `app`, and one with no directory at all by its host.
 */
function projectName(projectPath: string): string {
  if (!projectPath.startsWith('ssh://')) {
    return projectPath.split(/[\\/]/).filter(Boolean).pop() ?? '';
  }
  const rest = projectPath.slice('ssh://'.length);
  const slash = rest.indexOf('/');
  const dir = slash === -1 ? '' : rest.slice(slash + 1);
  const segment = dir.split('/').filter(part => part && part !== '~').pop();
  if (segment) return segment;
  const host = slash === -1 ? rest : rest.slice(0, slash);
  return host.split('@').pop()?.split(':')[0] ?? host;
}

/**
 * Two letters that stand for a project at 32px.
 *
 * A name that is several words gives up their initials (`my-app` → `MA`,
 * `switchboard.old` → `SO`); a single word gives its first two letters with
 * only the first capitalised (`switchboard` → `Sw`), because `SW` reads as an
 * acronym for something it is not. The full label is on the tile's `title`
 * either way — the monogram only has to be distinguishable from its neighbours.
 */
export function monogramFor(projectPath: string): string {
  const words = projectName(projectPath).split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const word = words[0];
  if (word.length === 1) return word[0].toUpperCase();
  return word[0].toUpperCase() + word[1].toLowerCase();
}

/** When anything last happened in a project; 0 for one with no sessions. */
export function lastActivityAt(project: RailProject): number {
  let newest = 0;
  for (const session of project.sessions) {
    const at = new Date(session.modified).getTime();
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * The rail's project tiles, in the order they are drawn.
 *
 * Local projects most-recently-active first, then the remote ones on the same
 * rule — a remote project is a place you visit rather than the repo you live
 * in, and it costs an ssh handshake to look at, so it sits below the divider
 * however recently it was touched. Paths in `absorbed` get no tile: they are
 * another listed project's worktree and are drawn as a sub-tile under it.
 *
 * Ties break on the path so the rail does not reshuffle between reloads. A
 * project with no sessions at all has no activity to sort on and would
 * otherwise land wherever the project list happened to put it.
 */
export function orderRailProjects<P extends RailProject>(
  projects: readonly P[],
  absorbed: ReadonlySet<string>,
): P[] {
  const local: P[] = [];
  const remote: P[] = [];
  for (const project of projects) {
    if (absorbed.has(project.projectPath)) continue;
    (project.remote === true ? remote : local).push(project);
  }
  const byRecency = (a: P, b: P): number =>
    (lastActivityAt(b) - lastActivityAt(a)) || a.projectPath.localeCompare(b.projectPath);
  local.sort(byRecency);
  remote.sort(byRecency);
  return [...local, ...remote];
}

export interface RailSplit<T> {
  shown: T[];
  hidden: T[];
}

/**
 * How much of the rail fits, and what spills into the flyout.
 *
 * `budgetPx` is the height left for project tiles once the All tile, the
 * dividers and the add button have taken theirs; `costOf` is a tile's height
 * including the gap above it, which for the scoped project also covers its
 * worktree sub-tiles. When everything fits nothing is hidden; otherwise the
 * last slot is spent on the `+N` tile that opens the flyout, so one tile fewer
 * is shown than would strictly fit.
 *
 * The rail does not scroll (a 48px scrollbar is not a control anyone can hit),
 * which is why running out of room has to be answered rather than tolerated.
 */
export function splitForRail<T>(
  tiles: readonly T[],
  costOf: (tile: T) => number,
  budgetPx: number,
  overflowCostPx: number = RAIL_TILE_PX + RAIL_GAP_PX,
): RailSplit<T> {
  let total = 0;
  for (const tile of tiles) total += costOf(tile);
  if (total <= budgetPx) return { shown: [...tiles], hidden: [] };

  const shown: T[] = [];
  let used = 0;
  for (let i = 0; i < tiles.length; i++) {
    const cost = costOf(tiles[i]);
    if (used + cost + overflowCostPx > budgetPx) return { shown, hidden: tiles.slice(i) };
    used += cost;
    shown.push(tiles[i]);
  }
  return { shown, hidden: [] };
}

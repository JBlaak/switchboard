/**
 * Which project or worktree the session list is narrowed to.
 *
 * Scope is a filter, not a mode: null means "All", and the list then renders
 * exactly as it does without a rail. This store remembers the choice, tells the
 * sidebar and the rail when it changes, and carries the one piece of git
 * knowledge the filter needs — each project's worktree list — which the rail
 * fills in as it learns it.
 *
 * Persisted in Web Storage rather than in the `global` setting on purpose. The
 * setting is read over IPC in `applyStoredSettings()`, which bootstrap fires
 * and does not wait for alongside `loadProjects()`; whichever resolves first,
 * the very first render must already be narrowed, or the user watches the whole
 * list paint and then collapse to their scope on every launch. `localStorage`
 * is synchronous and read here at module load, so the scope is in hand before
 * anything can draw — the same reason `gridViewActive` lives there.
 */
import { narrowToScope } from '../../domain/git/scope';
import { STORAGE_KEYS, pendingSessions, readStored, writeStored } from './session-store';
import type { Scope } from '../../domain/git/types';

type ScopeListener = (scope: Scope | null) => void;

const EMPTY: readonly string[] = [];

/**
 * Only a well-formed scope is trusted. Anything else — a hand-edited value, the
 * shape an older build wrote — reads as "All" rather than breaking the boot.
 */
function parseStored(raw: string | null): Scope | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const projectPath = record.projectPath;
    const worktreePath = record.worktreePath ?? null;
    if (typeof projectPath !== 'string' || projectPath === '') return null;
    if (worktreePath !== null && typeof worktreePath !== 'string') return null;
    return { projectPath, worktreePath };
  } catch {
    return null;
  }
}

let scope: Scope | null = parseStored(readStored('localStorage', STORAGE_KEYS.scope));
const listeners = new Set<ScopeListener>();
/** projectPath, as the project list spells it → what `git worktree list` printed, primary first. */
const knownWorktrees = new Map<string, readonly string[]>();

export function getScope(): Scope | null {
  return scope;
}

function sameScope(a: Scope | null, b: Scope | null): boolean {
  if (a === null || b === null) return a === b;
  return a.projectPath === b.projectPath && a.worktreePath === b.worktreePath;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

/**
 * Tell the listeners.
 *
 * One that throws is logged and skipped: a rail that fails to highlight its
 * tile must not stop the list from narrowing, or take the listeners after it
 * down with it.
 */
function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener(scope);
    } catch (err) {
      console.error('scope listener failed', err);
    }
  }
}

/**
 * Narrow the list to `next`, or to everything with null. Persists, then tells
 * the listeners.
 *
 * Choosing what is already chosen is not a change and stays silent, so the
 * rail can set the scope on every click without costing a redraw.
 */
export function setScope(next: Scope | null): void {
  if (sameScope(scope, next)) return;
  scope = next === null ? null : { projectPath: next.projectPath, worktreePath: next.worktreePath };
  writeStored('localStorage', STORAGE_KEYS.scope, scope === null ? null : JSON.stringify(scope));
  notify();
}

/**
 * Be told each time the scope changes — or each time what it admits changes,
 * see `setKnownWorktrees`. Returns the unsubscribe.
 */
export function onScopeChange(listener: ScopeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The worktrees of a project, as last reported.
 *
 * Empty until the rail has run `git worktree list` for it, and the filter still
 * works without it — on the projectPath and on the `.claude/worktrees`
 * directory shape. Only a plain `git worktree add ../x` checkout needs the list
 * to be tied to its parent.
 */
export function knownWorktreesFor(projectPath: string): readonly string[] {
  return knownWorktrees.get(projectPath) ?? EMPTY;
}

/**
 * Record what `git worktree list` printed for a project, in git's order.
 *
 * When this changes the list for the project currently in scope, the listeners
 * hear about it as a scope change although the scope itself is the same: the
 * set of rows the scope admits just changed — a plain worktree's sessions may
 * now belong — and that is all a listener cares about. An identical list is
 * silent, so re-reporting after every refresh cannot loop.
 */
export function setKnownWorktrees(projectPath: string, paths: readonly string[]): void {
  const before = knownWorktreesFor(projectPath);
  const after = [...paths];
  knownWorktrees.set(projectPath, after);
  if (sameList(before, after)) return;
  if (scope !== null && scope.projectPath === projectPath) notify();
}

/**
 * Drop the scope once its project has left the list.
 *
 * A project can vanish between runs — its transcripts deleted, its folder
 * moved — and a scope naming it would narrow the list to nothing, with no tile
 * on the rail to click out of. Silent when the scope still holds or there is
 * none.
 */
export function reconcileScopeWithProjects(projects: readonly { projectPath: string }[]): void {
  if (scope === null) return;
  const current = scope;
  if (projects.some(project => project.projectPath === current.projectPath)) return;
  setScope(null);
}

/**
 * Drop a checkout the rail can no longer see: it was deleted from disk.
 *
 * The other half of `reconcileScopeWithProjects`. That one answers a *project*
 * leaving the list, where there is nothing left to look at and the scope has to
 * go. A worktree is not the same case — its sessions and their transcripts are
 * still there, which is why the rail keeps a dashed tile for it rather than
 * dropping it — so this is only ever called deliberately, from that tile's
 * `Forget`.
 *
 * Takes the path out of the project's known list as well as out of the scope,
 * so the last `git worktree list` that mentioned it stops speaking for it: the
 * filter would otherwise keep admitting its rows into the whole-project scope
 * until the next successful read replaced the list anyway.
 */
export function forgetWorktree(projectPath: string, worktreePath: string): void {
  const known = knownWorktrees.get(projectPath);
  if (known) setKnownWorktrees(projectPath, known.filter(path => path !== worktreePath));
  if (scope === null) return;
  if (scope.projectPath !== projectPath || scope.worktreePath !== worktreePath) return;
  setScope({ projectPath, worktreePath: null });
}

/**
 * The project list as the sidebar and the search see it: narrowed to the
 * scope, with the rows the renderer invented for sessions the CLI has not
 * started yet always admitted. A `--worktree` launch has no cwd until the CLI
 * has created the checkout, and hiding the row the user just clicked would read
 * as the launch having failed.
 *
 * Hands the input back untouched when there is no scope; see `narrowToScope`.
 */
export function scopedProjects<
  P extends { projectPath: string; sessions: readonly { sessionId: string; cwd?: string | null; projectPath: string }[] },
>(projects: readonly P[]): P[] {
  return narrowToScope(
    projects,
    scope,
    scope === null ? EMPTY : knownWorktreesFor(scope.projectPath),
    sessionId => pendingSessions.has(sessionId),
  );
}

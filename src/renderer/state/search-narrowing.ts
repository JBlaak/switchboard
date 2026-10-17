/**
 * What a search narrows the session list to, before it is laid out.
 *
 * Nothing here reads the DOM or the store, so it is tested in node; the
 * search itself runs in main, and `ui/toolbar/actions` and
 * `ui/session-list/relayout` hand its answer through these.
 */
import { shortProjectPath } from '../../domain/project/project-path';
import type { Project } from '../../domain/project/project';

/** The parts of the view that decide which projects are laid out. */
export interface SearchNarrowing {
  readonly showArchived: boolean;
  /** null = no search active; a Set = the matched session ids. */
  readonly searchMatchIds: ReadonlySet<string> | null;
  /** Project paths matched by name, so their rows survive the filter. */
  readonly searchMatchProjectPaths: ReadonlySet<string> | null;
}

/**
 * Which projects a layout covers: `active` (the unarchived list) or `all`.
 *
 * A search ignores the archive filter — a session you searched for should be
 * findable whether or not it is archived — so it always lays out from the full
 * list, narrowed to the matches.
 */
export function projectsToRender(
  active: readonly Project[], all: readonly Project[], narrowing: SearchNarrowing,
): readonly Project[] {
  const matchIds = narrowing.searchMatchIds;
  const source = matchIds !== null || narrowing.showArchived ? all : active;

  if (matchIds === null) return source;

  const matchedPaths = narrowing.searchMatchProjectPaths;
  const narrowed: Project[] = [];
  for (const project of source) {
    const hasMatchingSessions = project.sessions.some(s => matchIds.has(s.sessionId));
    const projectMatched = matchedPaths?.has(project.projectPath) ?? false;
    if (!hasMatchingSessions && !projectMatched) continue;
    // A project whose name matches contributes all of its sessions — there is
    // no directory header left to stand in for the project itself.
    narrowed.push({
      ...project,
      sessions: hasMatchingSessions
        ? project.sessions.filter(s => matchIds.has(s.sessionId))
        : project.sessions,
    });
  }
  return narrowed;
}

/** Projects whose own short name contains the query, or null when none does. */
export function matchingProjectPaths(query: string, projects: readonly Project[]): Set<string> | null {
  const needle = query.toLowerCase();
  const matched = new Set<string>();
  for (const project of projects) {
    if (shortProjectPath(project.projectPath).toLowerCase().includes(needle)) {
      matched.add(project.projectPath);
    }
  }
  return matched.size ? matched : null;
}

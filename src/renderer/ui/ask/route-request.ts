/**
 * The request the box on the empty screen sends (#135): what was typed, and
 * the projects Claude may route it to.
 *
 * Built here, in one place, from the projects the renderer has loaded; which
 * of them count as candidates, and what is said about each, is a rule of the
 * routing itself (R2, R3).
 */
import { isWorktreeProject } from '../../features/sessions/project-label';
import type { Project } from '../../../domain/project/project';
import type { RouteCandidate, RouteRequest } from '../../../domain/ask/model';

/** `text` is sent exactly as typed. */
export function routeRequest(text: string, projects: readonly Project[]): RouteRequest {
  return { text, candidates: routeCandidates([...projects]) };
}

/** How many recent session titles a candidate carries. */
const RECENT_TITLES = 5;

// TODO(#135 merge): replace with routeCandidates from domain/ask/route
function routeCandidates(projects: Project[]): RouteCandidate[] {
  return projects
    .filter(project => !project.remote && !isWorktreeProject(project.projectPath))
    .map(project => ({
      projectPath: project.projectPath,
      folder: project.projectPath.split('/').filter(Boolean).pop() ?? project.projectPath,
      recentTitles: [...project.sessions]
        .sort((a, b) => b.modified.localeCompare(a.modified))
        .slice(0, RECENT_TITLES)
        .map(session => session.name || session.summary),
    }));
}

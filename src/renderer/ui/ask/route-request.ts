/**
 * The request the box on the empty screen sends (#135): what was typed, and
 * the projects Claude may route it to.
 *
 * Built here, in one place, from the projects the renderer has loaded; which
 * of them count as candidates, and what is said about each, is a rule of the
 * routing itself (R2, R3).
 */
import { routeCandidates } from '../../../domain/ask/route';
import type { Project } from '../../../domain/project/project';
import type { RouteRequest } from '../../../domain/ask/model';

/** `text` is sent exactly as typed. */
export function routeRequest(text: string, projects: readonly Project[]): RouteRequest {
  return { text, candidates: routeCandidates([...projects]) };
}

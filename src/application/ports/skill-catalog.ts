/**
 * The skills and slash commands Claude Code would offer a session, as a
 * dependency (#142).
 *
 * Quick Ask hands their names to the routing call, so a request that names a
 * skill keeps its name. The files are the CLI's and change under us, so they
 * are read afresh for each request.
 */
import type { RouteSkills } from '../../domain/ask/skills';

export interface SkillCatalog {
  /** Everyone's skills, and each of these projects' own; empty where nothing can be read. */
  list(projectPaths: string[]): RouteSkills;
}

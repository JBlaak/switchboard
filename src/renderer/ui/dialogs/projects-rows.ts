/**
 * The Projects modal's rows for a search (#171): the add row a path or an
 * ssh target offers on top, the matching projects with each worktree under
 * the repository it was cut from, and "Add project…" always last.
 *
 * Pure, so the rules run under the node test runner without a DOM.
 */
import { worktreeParentPath } from '../../../domain/project/project-path';
import { rankProjects } from './rank-projects';
import type { Candidate } from './rank-projects';
import type { ProjectsQuery } from './projects-query';
import type { Project } from '../../../domain/project/project';

export type ProjectsRow =
  /** Add the folder the search names. */
  | { readonly kind: 'add-folder'; readonly path: string }
  /** Open the add step on the SSH tab, filled in from the search. */
  | { readonly kind: 'add-remote'; readonly user: string; readonly host: string; readonly port: string }
  /** A project; `nested` when it is a worktree listed under its repository. */
  | { readonly kind: 'project'; readonly candidate: Candidate; readonly nested: boolean }
  /** Open the add step. */
  | { readonly kind: 'add-project' };

/** Every row, top to bottom, for the search as classified. */
export function projectsRows(projects: readonly Project[], query: ProjectsQuery): ProjectsRow[] {
  const rows: ProjectsRow[] = [];
  let filter: string;
  switch (query.kind) {
    case 'path':
      rows.push({ kind: 'add-folder', path: query.path });
      filter = query.path;
      break;
    case 'ssh':
      rows.push({ kind: 'add-remote', user: query.user, host: query.host, port: query.port });
      filter = `${query.user}@${query.host}`;
      break;
    case 'filter':
      filter = query.text;
      break;
  }
  for (const { candidate, nested } of nestWorktrees(rankProjects(projects, filter))) {
    rows.push({ kind: 'project', candidate, nested });
  }
  rows.push({ kind: 'add-project' });
  return rows;
}

/**
 * The candidates in their order, except that a worktree whose repository is
 * also listed moves up to just under it, after any worktrees already there.
 */
export function nestWorktrees(candidates: readonly Candidate[]): { candidate: Candidate; nested: boolean }[] {
  const listed = new Set(candidates.map(candidate => candidate.project.projectPath));
  const children = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const parent = worktreeParentPath(candidate.project.projectPath);
    if (!parent || !listed.has(parent)) continue;
    const under = children.get(parent) ?? [];
    under.push(candidate);
    children.set(parent, under);
  }

  const out: { candidate: Candidate; nested: boolean }[] = [];
  const emit = (candidate: Candidate, nested: boolean): void => {
    out.push({ candidate, nested });
    for (const child of children.get(candidate.project.projectPath) ?? []) emit(child, true);
  };
  for (const candidate of candidates) {
    const parent = worktreeParentPath(candidate.project.projectPath);
    if (!parent || !listed.has(parent)) emit(candidate, false);
  }
  return out;
}

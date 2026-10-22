/**
 * A project's name as a way into its page (#173): a click opens the project
 * page, ⌘-click the repository on GitHub (nothing for a remote project).
 * Hovering tints and underlines it, and the tooltip names both.
 *
 * The same everywhere a project is named: a sidebar row's label, a slug
 * group's, and the terminal header's. A row's label sits inside its Session
 * work button, so this is a span that keeps its click to itself rather than a
 * link or a button, which a button cannot hold.
 */
import type { JSX, MouseEvent, ReactNode } from 'react';
import { projectLabel, repositoryRoot } from '../../features/sessions/project-label';
import { clickProjectName, isRemoteProject } from './actions';

export interface ProjectLinkProps {
  /** The project the name stands for; a worktree opens its repository's page. */
  path: string;
  className?: string;
  id?: string;
  children: ReactNode;
}

export function ProjectLink({ path, className, id, children }: ProjectLinkProps): JSX.Element {
  const onClick = (e: MouseEvent<HTMLElement>): void => {
    e.stopPropagation();
    e.preventDefault();
    clickProjectName(path, e.metaKey);
  };
  return (
    <span
      id={id}
      className={'project-link' + (className ? ' ' + className : '')}
      data-testid="project-link"
      data-project-path={path}
      title={projectLinkTitle(path)}
      onClick={onClick}
    >
      {children}
    </span>
  );
}

/** The tooltip: what a click does, and what ⌘-click does where there is a GitHub to open. */
export function projectLinkTitle(path: string): string {
  const open = 'Open ' + projectLabel(repositoryRoot(path));
  return isRemoteProject(path) ? open : open + '\n⌘-click opens GitHub';
}

/**
 * A project's name as a way into its page (#173): a click opens the project
 * page, ⌘-click the repository on GitHub (nothing for an agentless remote
 * project; a VM project's, #276, opens). Hovering tints and underlines it,
 * and the tooltip names both.
 *
 * The same everywhere a project is named: a sidebar row's label, a slug
 * group's, and the terminal header's. A row's label sits inside its Session
 * work button, so this is a span that keeps its click to itself rather than a
 * link or a button, which a button cannot hold.
 */
import type {JSX, MouseEvent, ReactNode} from 'react';
import {clickProjectName} from './actions';
import {isVmRepositoryIn, projectLinkTitle} from './page-state';
import {useStore} from '../use-store';

export interface ProjectLinkProps {
    /** The project the name stands for; a worktree opens its repository's page. */
    path: string;
    className?: string;
    id?: string;
    children: ReactNode;
}

export function ProjectLink({path, className, id, children}: ProjectLinkProps): JSX.Element {
    const vm = useStore((state) => isVmRepositoryIn(state.agentHost, path));
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
            title={projectLinkTitle(path, vm)}
            onClick={onClick}>
            {children}
        </span>
    );
}

/**
 * The badge a remote project carries (#276): SSH for a host Switchboard
 * reaches over ssh and tmux, VM for one that runs a Switchboard agent. A local
 * project has none.
 */
import {parseRemoteProjectPath} from '../../../domain/project/remote-target';
import type {Project} from '../../../domain/project/project';

export interface RemoteBadge {
    readonly label: 'SSH' | 'VM';
    /** The tooltip; none on the SSH badge, which has never had one. */
    readonly title?: string;
}

export function remoteBadge(project: Pick<Project, 'projectPath' | 'remote' | 'agent'>): RemoteBadge | null {
    if (!project.remote) return null;
    if (!project.agent) return {label: 'SSH'};
    return {label: 'VM', title: 'Runs on a Switchboard agent on ' + hostOf(project.projectPath)};
}

/** `user@host`, with the port when it isn't 22. */
function hostOf(projectPath: string): string {
    const remote = parseRemoteProjectPath(projectPath);
    if (!remote) return projectPath.replace(/^ssh:\/\//, '');
    return remote.user + '@' + remote.host + (remote.port === 22 ? '' : ':' + remote.port);
}

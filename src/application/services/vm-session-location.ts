/**
 * Where a VM session's transcripts are, named as the Mac's services name them (#276 stage 4).
 *
 * The services that read a session's transcripts (the session work page, the
 * Plan tab, worktree cleanup, task links) find it through the composition
 * root's `locateSession`: a transcript folder and the project it belongs to.
 * A local session's folder is a directory under the Mac's
 * `~/.claude/projects`. A VM session's is a directory under the VM's, which
 * the Mac names `vm:<user>@<host>:<port>:<encoded>` (`vmFolder`), so the
 * routing transcript store can send its reads to that host.
 *
 * `<encoded>` is the name the CLI on the VM gave the folder: the session's
 * working directory there, encoded as Claude encodes every project path
 * (`encodeProjectPath`). That directory is what the session's transcript
 * says (`VmTranscripts.cwd`), fetched when its host last connected. Before
 * the first fetch it falls back to the project's own folder when that is an
 * absolute path; a `~` path cannot be encoded without knowing the VM's home,
 * so then the folder is unknown (null), as for a local session that has not
 * written a transcript yet.
 */
import {vmFolder, type VmHost} from '../../domain/agent/vm-paths';
import {encodeProjectPath} from '../../domain/project/project-path';
import {parseRemoteProjectPath, remoteProjectPath} from '../../domain/project/remote-target';
import type {RemoteProjectSetting} from '../../domain/settings/settings';

/** Where a session's transcripts live and the project it belongs to, as `locateSession` answers. */
export interface VmSessionLocation {
    /** `vmFolder(host, encoded)`; null while the VM folder is not known yet. */
    folder: string | null;
    /** The VM project's path (`ssh://…`), as the sidebar and the project page know it. */
    projectPath: string;
}

export interface VmSessionLocationDeps {
    /**
     * The running session by this id: its project path, and whether it runs on
     * an agent (its PTY is an AgentPty). Null when none runs.
     */
    live(sessionId: string): {projectPath: string; onAgent: boolean} | null;
    /** The remote projects, with the sessions recorded on each. */
    remoteProjects(): readonly RemoteProjectSetting[];
    /** The session's working directory on the VM, absolute, as its transcript said; null when not fetched yet. */
    vmCwd(sessionId: string): string | null;
}

/**
 * The VM session's location; null when `sessionId` is not a VM session: not
 * running on an agent, nor recorded on a remote project whose host has one.
 * A session on an agentless remote is not a VM session (its transcript is in
 * tmux on the box, with nobody to ask).
 */
export function locateVmSession(deps: VmSessionLocationDeps, sessionId: string): VmSessionLocation | null {
    const found = vmSessionProject(deps, sessionId);
    if (!found) return null;
    const cwd = deps.vmCwd(sessionId) ?? (found.dir?.startsWith('/') ? found.dir : null);
    return {
        folder: cwd ? vmFolder(found.host, encodeProjectPath(cwd)) : null,
        projectPath: found.projectPath,
    };
}

/** The session's host and project, from the registry first (it knows the PTY), else the settings' records. */
function vmSessionProject(
    deps: VmSessionLocationDeps,
    sessionId: string,
): {host: VmHost; projectPath: string; dir: string | null} | null {
    const live = deps.live(sessionId);
    if (live?.onAgent) {
        const parsed = parseRemoteProjectPath(live.projectPath);
        if (parsed) {
            return {
                host: {user: parsed.user, host: parsed.host, port: parsed.port},
                projectPath: live.projectPath,
                dir: parsed.dir,
            };
        }
    }
    for (const remote of deps.remoteProjects()) {
        if (!remote.agent || !remote.sessions?.some((record) => record.sessionId === sessionId)) continue;
        return {
            host: {user: remote.user, host: remote.host, port: Number(remote.port) || 22},
            projectPath: remoteProjectPath(remote),
            dir: remote.dir ?? null,
        };
    }
    return null;
}

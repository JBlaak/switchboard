/**
 * The VM projects a worktree leaves behind.
 *
 * A local project's row comes from its transcripts, so it goes once its
 * sessions are archived. A VM folder's row comes from a record in the
 * settings (`remoteProjects`), made when a session first started there, and
 * stays until that record goes. Every VM worktree an issue, task or errand
 * session worked in would stay listed, with "0 sessions", long after the
 * archive cleanup removed the worktree. These pick out the records to drop.
 *
 * A VM folder has two names: `~/projects/site/…` as a project was added, and
 * `/home/dev/projects/site/…` as git answers. With the VM's home known, both
 * are compared.
 */
import type {RemoteProjectSetting} from '../settings/settings';
import {sameHost} from '../settings/vm-hosts';
import {normalizeRemoteDir, parseRemoteProjectPath, remoteProjectPath} from './remote-target';

/** Where Switchboard and Claude Code put a repository's worktrees. */
const WORKTREES = '/.claude/worktrees/';

/** A VM folder with `~` (or a bare relative folder) anchored at the VM user's home. */
export function expandVmHome(dir: string, home: string): string {
    const root = home.replace(/\/+$/, '');
    if (dir === '~') return root;
    if (dir.startsWith('~/')) return root + dir.slice(1);
    if (dir.startsWith('/')) return dir;
    return root + '/' + dir;
}

/** A VM folder as written and, when the home is known, with `~` expanded. */
export function vmDirForms(dir: string | null | undefined, home: string | null): string[] {
    const raw = normalizeRemoteDir(dir) ?? '~';
    const expanded = home ? expandVmHome(raw, home) : null;
    return expanded && expanded !== raw ? [raw, expanded] : [raw];
}

/**
 * The paths of the VM projects that are `folder` or lie inside it: what is
 * left listed once that folder (a removed worktree) is gone. Never a project
 * the folder lies inside, such as the repository it was a worktree of.
 */
export function remoteProjectsIn(
    remotes: readonly RemoteProjectSetting[],
    folder: string,
    home: string | null,
): string[] {
    const parsed = parseRemoteProjectPath(folder);
    if (!parsed || !normalizeRemoteDir(parsed.dir)) return [];
    const targets = vmDirForms(parsed.dir, home);
    return remotes
        .filter((remote) => sameHost(remote, parsed))
        .filter((remote) =>
            vmDirForms(remote.dir, home).some((dir) =>
                targets.some((target) => dir === target || dir.startsWith(target + '/')),
            ),
        )
        .map(remoteProjectPath);
}

/** A VM worktree project the sweep may look at: on the host, and nothing in it still listed. */
export interface WorktreeProjectCandidate {
    /** The project, as the list names it. */
    path: string;
    /** The repository folder its worktree was made in. */
    repository: string;
}

/**
 * The VM projects on `host` that are worktrees (a folder under
 * `.claude/worktrees/`) with no session left that is not archived: the ones
 * that, when git no longer finds the folder, are only a stale row.
 */
export function worktreeProjectCandidates(
    remotes: readonly RemoteProjectSetting[],
    host: {user: string; host: string; port: number},
    archived: (sessionId: string) => boolean,
): WorktreeProjectCandidate[] {
    const candidates: WorktreeProjectCandidate[] = [];
    for (const remote of remotes) {
        if (!sameHost(remote, host)) continue;
        if ((remote.sessions ?? []).some((session) => !archived(session.sessionId))) continue;
        const path = remoteProjectPath(remote);
        const at = path.indexOf(WORKTREES);
        if (at < 0 || path.length <= at + WORKTREES.length) continue;
        candidates.push({path, repository: path.slice(0, at)});
    }
    return candidates;
}

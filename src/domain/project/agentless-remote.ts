/**
 * Which remote paths the Mac's services still turn away (#276 stage 4).
 *
 * Until stage 4 the project page, plans, session work, issue sessions,
 * worktree cleanup and Open repository refused every `ssh://` path: a remote
 * checkout is not on the Mac's disk, so git and `gh` had nothing to read. A
 * host with a Switchboard agent answers those reads itself (its git and gh
 * run on the VM, behind VM-named paths), so its paths may go through. A host
 * without one is still a bare ssh+tmux box, and keeps every guard it had.
 *
 * The question is asked per host, not per project: a VM path the services
 * meet is often not a project's own path (a worktree under it, a `cwd` from a
 * transcript, the absolute form of a `~` project), but it is always on the
 * host of one, and the agent is installed per host.
 */
import {parseRemoteProjectPath, type RemoteConfig} from './remote-target';

/** A remote as the settings record it: its host, and whether an agent is installed there. */
export type RemoteHostRecord = Pick<RemoteConfig, 'user' | 'host' | 'port'> & {agent?: unknown};

/** `user@host:port` of a remote; the port defaults to ssh's 22, as everywhere a host is keyed. */
function hostKey(remote: Pick<RemoteConfig, 'user' | 'host' | 'port'>): string {
    return `${remote.user}@${remote.host}:${Number(remote.port) || 22}`;
}

/**
 * Whether `path` is a remote path on a host with no Switchboard agent: one the
 * services keep turning away. False for a local path, and for any path on a
 * host some remote record marks as having an agent.
 */
export function isAgentlessRemote(path: string, remotes: readonly RemoteHostRecord[]): boolean {
    const parsed = parseRemoteProjectPath(path);
    if (!parsed) return false;
    const key = hostKey(parsed);
    return !remotes.some((remote) => remote.agent && hostKey(remote) === key);
}

/**
 * `isAgentlessRemote` over the remotes as they are at each call: what the
 * composition root injects into each service as its guard, so installing an
 * agent lifts the guards without a restart.
 */
export function agentlessRemoteGuard(remotes: () => readonly RemoteHostRecord[]): (path: string) => boolean {
    return (path) => isAgentlessRemote(path, remotes());
}

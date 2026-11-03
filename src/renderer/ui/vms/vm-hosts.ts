/**
 * Naming a registered VM from the renderer (#307): its key from a project's
 * `ssh://` path, its host path from the key, its address, and which VM a
 * remote project's page links to, or offers to register.
 *
 * Pure, so it is tested in node.
 */
import {parseVmHostKey, splitVmPath, vmHostKey, vmHostPath} from '../../../domain/agent/vm-paths';
import type {VmHostView} from '../../../application/services/vm-registry';

/** `user@host:port`, the VM key of the host an `ssh://` path is on; null for a local path. */
export function hostKeyOfPath(path: string): string | null {
    const split = splitVmPath(path);
    return split ? vmHostKey(split.host) : null;
}

/** `ssh://user@host[:port]`, the address the per-host `AgentHosts` calls take for a VM; null for a bad key. */
export function hostPathOfKey(key: string): string | null {
    const host = parseVmHostKey(key);
    return host ? vmHostPath(host) : null;
}

/** A VM key as it can go in an element id. */
export function vmSlug(key: string): string {
    return key.replace(/[^a-zA-Z0-9_-]/g, '-');
}

/** `user@host`, with `:port` when it isn't 22, as a VM's address reads. */
export function vmAddress(vm: {user: string; host: string; port: number}): string {
    return `${vm.user}@${vm.host}${vm.port === 22 ? '' : ':' + vm.port}`;
}

/** The registered VM a project path is on, if any. */
export function vmOfPath(hosts: readonly VmHostView[] | null, path: string): VmHostView | null {
    const key = hostKeyOfPath(path);
    return (key && hosts?.find((vm) => vm.key === key)) || null;
}

/**
 * What a remote project's page says of its host:
 * - `vm`: "On <label> · Manage in Settings", for a host that is registered,
 *   or a VM project whose VM the list hasn't named yet (by its address);
 * - `register`: an agentless remote on a host that isn't registered, which
 *   offers to register it;
 * - null for a local project.
 */
export type HostLink =
    | {readonly kind: 'vm'; readonly key: string; readonly label: string}
    | {readonly kind: 'register'; readonly user: string; readonly host: string; readonly port: number};

export function hostLinkOf(
    projectPath: string,
    vmProject: boolean,
    hosts: readonly VmHostView[] | null,
): HostLink | null {
    const split = splitVmPath(projectPath);
    if (!split) return null;
    const registered = vmOfPath(hosts, projectPath);
    if (registered) return {kind: 'vm', key: registered.key, label: registered.label};
    if (vmProject) return {kind: 'vm', key: vmHostKey(split.host), label: vmAddress(split.host)};
    return {kind: 'register', ...split.host};
}

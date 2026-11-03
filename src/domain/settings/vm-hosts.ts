/**
 * The VM registry's rules (#276, Settings → VMs), as pure functions over the
 * stored records, so the settings service and its tests share one meaning.
 *
 * A VM is registered on its own, as a phone is paired: a host
 * (`user@host:port`) with no folder. The registry is the one answer to "does
 * this host run a Switchboard agent?". A remote project's `agent` is derived
 * from it, never trusted from the project's own record: older builds stored
 * `agent` on every remote of a host, and a record that outlived its VM's
 * registration (or was written before an uninstall) must not make a host look
 * like a VM.
 */
import type {RemoteProjectSetting, VmHostSetting} from './settings';

/** The host part of a VM or a remote, as both name one. */
export type HostAddress = {user: string; host: string; port: number | string};

/** ssh's default when a record has none, as everywhere a host is keyed. */
function portOf(address: HostAddress): number {
    return Number(address.port) || 22;
}

/** Whether `a` and `b` name the same host: same user, host and port. */
export function sameHost(a: HostAddress, b: HostAddress): boolean {
    return a.user === b.user && a.host === b.host && portOf(a) === portOf(b);
}

/** The registration of `address`'s host in `hosts`, or null when it isn't registered. */
export function findVmHostIn(hosts: readonly VmHostSetting[], address: HostAddress): VmHostSetting | null {
    return hosts.find((vm) => sameHost(vm, address)) ?? null;
}

/** What the UI calls a VM: its name, or `user@host` (with `:port` when it isn't 22). */
export function vmHostLabel(vm: Pick<VmHostSetting, 'user' | 'host' | 'port' | 'name'>): string {
    if (vm.name) return vm.name;
    const port = portOf(vm);
    return `${vm.user}@${vm.host}${port === 22 ? '' : ':' + port}`;
}

/**
 * The registry an install from before `vmHosts` existed implies: every host
 * some stored remote marks with `agent`, once, with that agent's version.
 *
 * When two remotes on one host disagree (an upgrade marked one record only, in
 * a build that did that), the newest install wins: it is the agent that runs
 * there now. The registration date is the install's, as the closest thing to
 * when the user made it a VM.
 */
export function migrateVmHosts(remotes: readonly RemoteProjectSetting[] | undefined): VmHostSetting[] {
    const hosts: VmHostSetting[] = [];
    for (const remote of remotes ?? []) {
        if (!remote.agent) continue;
        const existing = findVmHostIn(hosts, remote);
        if (!existing) {
            hosts.push({
                user: remote.user,
                host: remote.host,
                port: portOf(remote),
                addedAt: remote.agent.installedAt,
                agent: {...remote.agent},
            });
        } else if (existing.agent && remote.agent.installedAt > existing.agent.installedAt) {
            existing.agent = {...remote.agent};
        }
    }
    return hosts;
}

/**
 * `remote` with `agent` as its host's registration says: the registration's
 * agent, or no `agent` at all when the host isn't registered or has none yet,
 * whatever the record itself stored. A copy; the stored record is untouched.
 */
export function withDerivedAgent(remote: RemoteProjectSetting, hosts: readonly VmHostSetting[]): RemoteProjectSetting {
    const {agent: _stored, ...rest} = remote;
    const agent = findVmHostIn(hosts, remote)?.agent;
    return agent ? {...rest, agent: {...agent}} : rest;
}

/**
 * Settings → VMs (#276, after stage 5): the `VmRegistry` façade over the
 * registry kept in settings, the agent links and forgetting remote projects.
 *
 * The registry itself (which hosts are VMs, and which agent each runs) lives
 * in `SettingsService`, beside the remote projects whose `agent` it decides.
 * This adds what the Settings page needs on top: the views it lists (with
 * whether each link is up, read without dialling, and the projects on it),
 * validation of a typed address, and removing a VM with everything this Mac
 * held for it, while the agent and its sessions go on running on the VM.
 */
import {remoteProjectPath, validateRemoteInput} from '../../domain/project/remote-target';
import {parseVmHostKey, vmHostKey} from '../../domain/agent/vm-paths';
import type {VmHost} from '../../domain/agent/vm-paths';
import {sameHost, vmHostLabel} from '../../domain/settings/vm-hosts';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {Clock} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {SettingsService} from './settings-service';
import type {VmHostView, VmRegistry} from './vm-registry';

export interface VmRegistryServiceDeps {
    settings: Pick<
        SettingsService,
        'vmHosts' | 'findVmHost' | 'addVmHost' | 'renameVmHost' | 'removeVmHost' | 'remoteProjects'
    >;
    /**
     * The agent links. `connection` makes a host's link without dialling it, so
     * listing never opens an ssh that may need the user's approval;
     * `disconnect` closes it for good, telling the agent nothing.
     */
    agents: {
        connection(host: VmHost): {connected: boolean};
        disconnect(host: VmHost): void;
    };
    /**
     * Forget one remote project here (`main/forget-remote-project.ts`): its
     * record, and its sessions, which on a VM are let go of, never stopped.
     */
    forgetRemoteProject(projectPath: string): void;
    renderer: Pick<RendererGateway, 'vmHostsChanged'>;
    /** The app's version: a VM whose agent is another is not `current`. */
    appVersion: string;
    clock: Clock;
    log: Logger;
}

export class VmRegistryService implements VmRegistry {
    constructor(private readonly deps: VmRegistryServiceDeps) {}

    public list(): VmHostView[] {
        const {settings, agents, appVersion} = this.deps;
        const remotes = settings.remoteProjects();
        return settings.vmHosts().map((vm) => {
            const host: VmHost = {user: vm.user, host: vm.host, port: Number(vm.port) || 22};
            const agent = vm.agent?.version ?? null;
            return {
                key: vmHostKey(host),
                ...host,
                label: vmHostLabel(vm),
                agent,
                current: agent === appVersion,
                connected: agents.connection(host).connected,
                projects: remotes.filter((remote) => sameHost(remote, host)).map(remoteProjectPath),
            };
        });
    }

    public add(input: {
        user: string;
        host: string;
        port?: number;
        name?: string;
    }): {ok: true; key: string} | {ok: false; error: string} {
        const user = typeof input.user === 'string' ? input.user.trim() : '';
        const hostName = typeof input.host === 'string' ? input.host.trim() : '';
        const port = input.port === undefined || input.port === null ? 22 : input.port;
        const invalid = validateRemoteInput({user, host: hostName, port});
        if (invalid) return {ok: false, error: invalid};

        const host: VmHost = {user, host: hostName, port: Number(port)};
        const label = vmHostLabel(host);
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        const added = this.deps.settings.addVmHost(
            {...host, ...(name ? {name} : {})},
            new Date(this.deps.clock.now()).toISOString(),
        );
        if (!added) return {ok: false, error: `${label} is already registered.`};
        this.deps.log.info(`[vm-registry] registered ${label}`);
        this.deps.renderer.vmHostsChanged();
        return {ok: true, key: vmHostKey(host)};
    }

    public rename(key: string, name: string): boolean {
        const host = parseVmHostKey(key);
        if (!host || typeof name !== 'string') return false;
        const renamed = this.deps.settings.renameVmHost(host, name);
        if (renamed) this.deps.renderer.vmHostsChanged();
        return renamed;
    }

    /**
     * Forget the VM and its projects here, in that order of care: each
     * project through the same path as the Projects list's Remove (which lets
     * go of VM sessions without signalling them), then the registration, then
     * the link, closed without a word to the agent. Registering it again finds
     * the agent and its sessions as they were.
     */
    public remove(key: string): {ok: true} | {ok: false; error: string} {
        const host = parseVmHostKey(key);
        if (!host) return {ok: false, error: `${key} does not name a VM.`};
        const {settings, agents, log} = this.deps;
        const vm = settings.findVmHost(host);
        if (!vm) return {ok: false, error: `${key} is not a registered VM.`};

        const projects = settings
            .remoteProjects()
            .filter((remote) => sameHost(remote, host))
            .map(remoteProjectPath);
        for (const projectPath of projects) this.deps.forgetRemoteProject(projectPath);
        settings.removeVmHost(host);
        agents.disconnect(host);
        log.info(`[vm-registry] removed ${vmHostLabel(vm)} and ${projects.length} project(s) on it`);
        this.deps.renderer.vmHostsChanged();
        return {ok: true};
    }
}

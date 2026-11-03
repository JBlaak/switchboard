/**
 * A remote project's page and its host (#307). The VM's controls are in
 * Settings → VMs, so the page only points there:
 *
 * - `VmLink`, in the header of a project on a registered VM (or a VM
 *   project): "On <VM> · Manage in Settings", which opens the settings at
 *   that VM.
 * - `RegisterVmCard`, under an agentless remote's sessions on a host that
 *   isn't registered: Register this host as a VM, which registers it and
 *   opens the settings at it, with Install agent ready.
 *
 * What each says is `hostLinkOf` (`vms/vm-hosts`).
 */
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {isVmProjectIn} from '../../state/agent-host-slice';
import {vmFailureIn} from '../../state/vms-slice';
import {hostLinkOf} from '../vms/vm-hosts';
import {vmFailureLine} from '../vms/vms-copy';
import {openVmSettings, registerHostAsVm} from '../vms/open-settings';
import type {HostLink} from '../vms/vm-hosts';

/** What the page says of a project's host; null for a local project. */
export function useHostLink(projectPath: string): HostLink | null {
    const vm = useStore((state) => isVmProjectIn(state.agentHost, projectPath));
    const hosts = useStore((state) => state.vms.hosts);
    return hostLinkOf(projectPath, vm, hosts);
}

export function VmLink({link}: {link: Extract<HostLink, {kind: 'vm'}>}): JSX.Element {
    return (
        <button
            type="button"
            className="pp-vm-link"
            title="Open this VM in Settings"
            onClick={() => void openVmSettings(link.key)}>
            On <span className="pp-vm-link-name">{link.label}</span> ·{' '}
            <span className="pp-vm-link-manage">Manage in Settings</span>
        </button>
    );
}

export const REGISTER_HELP =
    'Register this host as a VM to run its sessions with every Switchboard feature. Its agent is installed from Settings.';

export function RegisterVmCard({link}: {link: Extract<HostLink, {kind: 'register'}>}): JSX.Element {
    const failure = useStore((state) => vmFailureIn(state.vms, 'register'));
    return (
        <section className="pp-section pp-agent" aria-labelledby="pp-agent-heading">
            <div className="pp-section-head">
                <h2 id="pp-agent-heading">Switchboard agent</h2>
            </div>
            <div className="pp-card pp-message">
                <div className="pp-message-text">{REGISTER_HELP}</div>
                {failure !== null && (
                    <div className="pp-agent-error" role="alert">
                        {vmFailureLine('register', failure)}
                    </div>
                )}
                <div className="pp-message-actions">
                    <button
                        type="button"
                        className="sw-btn is-primary"
                        onClick={() => void registerHostAsVm({user: link.user, host: link.host, port: link.port})}>
                        Register this host as a VM
                    </button>
                </div>
            </div>
        </section>
    );
}

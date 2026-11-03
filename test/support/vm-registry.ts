/**
 * Fixtures for VM projects since the VM registry (#307): a remote is a VM
 * project because its host is registered with an agent, not because its own
 * record says so. Tests that used to set `agent` on a remote record go through
 * here, so what they exercise is the derivation.
 */
import {remoteProjectPath} from '../../src/domain/project/remote-target';
import type {SettingsService} from '../../src/application/services/settings-service';
import type {RemoteProjectSetting} from '../../src/domain/settings/settings';

/**
 * Add `remotes`, storing none of their `agent`s, and register the host of
 * each one that had an `agent` as a VM with that agent. The registry is made
 * first (empty), so the one-off migration from old agent records never runs.
 */
export function addRemotesRegisteringVms(settings: SettingsService, remotes: readonly RemoteProjectSetting[]): void {
    settings.vmHosts();
    for (const {agent, ...remote} of remotes) {
        settings.addRemoteProject(structuredClone(remote));
        if (agent) settings.markAgentInstalled(remoteProjectPath(remote), agent.version, agent.installedAt);
    }
}

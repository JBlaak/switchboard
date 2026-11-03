/**
 * What Settings → VMs says (#307), worked out from main's list and the agent
 * host slice: a VM row's agent and connection lines, Add a VM's message for
 * what it can't take, Remove's question and a failed call.
 *
 * Pure, so each is tested in node; the components only lay them out.
 */
import {validateRemoteInput} from '../../../domain/project/remote-target';
import {vmHostKey} from '../../../domain/agent/vm-paths';
import {offersUpdate} from './agent-host-view';
import {vmAddress} from './vm-hosts';
import type {VmHostView} from '../../../application/services/vm-registry';
import type {InstallState} from '../../state/agent-host-slice';
import type {VmCall} from '../../state/vms-slice';

/** A VM's agent, as its row says it; `tone` colours the line. */
export interface AgentLine {
    readonly text: string;
    readonly tone: 'ok' | 'update' | 'none' | 'busy';
}

export function agentLine(vm: VmHostView, install: InstallState): AgentLine {
    if (install.phase === 'running') return {text: vm.agent ? 'Updating…' : 'Installing…', tone: 'busy'};
    if (vm.agent === null) return {text: 'No agent yet', tone: 'none'};
    if (offersUpdate(vm)) return {text: 'Update available', tone: 'update'};
    return {text: `Agent ${vm.agent}`, tone: 'ok'};
}

/** Connected or Offline; null for a VM with no agent yet, which has nothing to connect to. */
export function connectionLine(vm: VmHostView): {readonly text: string; readonly connected: boolean} | null {
    if (vm.agent === null) return null;
    return vm.connected ? {text: 'Connected', connected: true} : {text: 'Offline', connected: false};
}

/** The address under a VM's label, or null when the label is the address already. */
export function addressLine(vm: VmHostView): string | null {
    const address = vmAddress(vm);
    return vm.label === address ? null : address;
}

/** What Add a VM is given, as typed. */
export interface AddVmInput {
    readonly user: string;
    readonly host: string;
    /** Empty for 22. */
    readonly port: string;
    readonly name: string;
}

/** Why Add a VM can't take this, or null when it can. */
export function addVmProblem(input: AddVmInput, hosts: readonly VmHostView[]): string | null {
    const user = input.user.trim();
    const host = input.host.trim();
    if (!user) return 'Enter the user to sign in as.';
    if (!host) return 'Enter the VM’s host name or address.';
    const invalid = validateRemoteInput({user, host, port: input.port.trim()});
    if (invalid) return invalid;
    const key = vmHostKey({user, host, port: addVmPort(input)});
    const known = hosts.find((vm) => vm.key === key);
    return known ? `${known.label} is registered already.` : null;
}

/** The port Add a VM asks for: what was typed, or 22. */
export function addVmPort(input: AddVmInput): number {
    const port = input.port.trim();
    return port ? Number(port) : 22;
}

/** What Remove asks first. */
export function removeVmPrompt(vm: VmHostView): string {
    return (
        `Remove “${vm.label}”?\n\n` +
        'Its projects leave the list here. The agent and its sessions keep running on the VM, ' +
        'and adding it again brings them back.'
    );
}

const FAILED: Record<VmCall, string> = {
    load: "Couldn't read the VMs",
    add: "Couldn't add the VM",
    rename: "Couldn't rename the VM",
    remove: "Couldn't remove the VM",
    register: "Couldn't register this host",
};

export function vmFailureLine(call: VmCall, message: string): string {
    return message ? `${FAILED[call]}: ${message}` : FAILED[call];
}

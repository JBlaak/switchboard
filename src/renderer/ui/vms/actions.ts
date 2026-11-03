/**
 * What Settings → VMs does (#307): every call to main's VM registry, and the
 * answer dispatched. The components call these, never `window.api` or the
 * store.
 *
 * The list is read again after each change, besides main's push, so the
 * section is right even before that push lands. A call that fails is
 * dispatched as a failure the section shows in place.
 *
 * Remove asks first: the VM's projects leave the list here.
 */
import {dispatch, getState} from '../../state/app-store';
import {vmHostsIn} from '../../state/vms-slice';
import {callErrorMessage} from '../phone-access/actions';
import {vmApi} from './vm-api';
import {vmSlug} from './vm-hosts';
import {addVmPort, addVmProblem, removeVmPrompt} from './vms-copy';
import type {AddVmInput} from './vms-copy';
import type {VmHostView} from './vm-api';

/** Asks the user; `window.confirm` in the app, a stand-in in a test. */
export type Ask = (prompt: string) => boolean;

const ask: Ask = (prompt) => confirm(prompt);

/** The id of the settings card, for Manage in Settings to bring it into view. */
export const VMS_SECTION_ID = 'sv-vms';

/** A VM row's id, for Manage in Settings to bring it into view. */
export function vmRowId(key: string): string {
    return 'sv-vm-' + vmSlug(key);
}

/**
 * Read the list, at launch, whenever the settings open and on main's push.
 * Quiet when it fails: what was listed stays.
 */
export async function loadVmHosts(): Promise<void> {
    try {
        const hosts: unknown = await vmApi().vmHosts();
        if (Array.isArray(hosts)) dispatch({type: 'vmHostsLoaded', hosts: hosts as VmHostView[]});
    } catch {
        // Main without the registry, or not answering yet: the list stays as it was.
    }
}

/** A row's click: its controls open, or close when they show. */
export function toggleVm(key: string): void {
    dispatch({type: 'vmHostOpened', key: getState().vms.open === key ? null : key});
}

/**
 * Add a VM: refused here for what main would refuse too (a bad address, one
 * registered already), else registered there. Answers whether it was added,
 * so the form can close; the VM then opens with Install agent ready.
 */
export async function addVm(input: AddVmInput): Promise<boolean> {
    dispatch({type: 'vmCallStarted', call: 'add'});
    const problem = addVmProblem(input, vmHostsIn(getState().vms));
    if (problem) {
        dispatch({type: 'vmCallFailed', call: 'add', message: problem});
        return false;
    }
    const name = input.name.trim();
    const key = await register('add', {
        user: input.user.trim(),
        host: input.host.trim(),
        port: addVmPort(input),
        ...(name ? {name} : {}),
    });
    return key !== null;
}

/** Register this host as a VM, from an agentless remote's page. Answers the VM's key, or null. */
export async function registerHost(host: {user: string; host: string; port: number}): Promise<string | null> {
    dispatch({type: 'vmCallStarted', call: 'register'});
    return register('register', host);
}

/** Registers it with main; answers its key, or null when main refused. */
async function register(
    call: 'add' | 'register',
    input: {user: string; host: string; port: number; name?: string},
): Promise<string | null> {
    try {
        const result = await vmApi().addVmHost(input);
        if (!result?.ok) {
            dispatch({type: 'vmCallFailed', call, message: result?.error ?? ''});
            return null;
        }
        dispatch({type: 'vmHostAdded', key: result.key});
        void loadVmHosts();
        return result.key;
    } catch (err) {
        dispatch({type: 'vmCallFailed', call, message: callErrorMessage(err)});
        return null;
    }
}

/** A new name, or none to go back to `user@host`. */
export async function renameVm(key: string, name: string): Promise<void> {
    dispatch({type: 'vmCallStarted', call: 'rename'});
    try {
        const result = await vmApi().renameVmHost(key, name.trim());
        const refused = refusal(result);
        if (refused !== null) dispatch({type: 'vmCallFailed', call: 'rename', message: refused});
    } catch (err) {
        dispatch({type: 'vmCallFailed', call: 'rename', message: callErrorMessage(err)});
    }
    void loadVmHosts();
}

/** Forget a VM and its projects here, after asking. The agent and its sessions keep running on the VM. */
export async function removeVm(vm: VmHostView, confirmed: Ask = ask): Promise<void> {
    if (!confirmed(removeVmPrompt(vm))) return;
    dispatch({type: 'vmCallStarted', call: 'remove'});
    try {
        const result = await vmApi().removeVmHost(vm.key);
        if (!result?.ok) dispatch({type: 'vmCallFailed', call: 'remove', message: result?.error ?? ''});
        else dispatch({type: 'vmHostOpened', key: null});
    } catch (err) {
        dispatch({type: 'vmCallFailed', call: 'remove', message: callErrorMessage(err)});
    }
    void loadVmHosts();
}

/** Why an answer is a refusal (`false`, or `{ok: false}`), or null when it isn't one. */
function refusal(result: unknown): string | null {
    if (result === false) return '';
    if (result && typeof result === 'object' && (result as {ok?: unknown}).ok === false) {
        const error = (result as {error?: unknown}).error;
        return typeof error === 'string' ? error : '';
    }
    return null;
}

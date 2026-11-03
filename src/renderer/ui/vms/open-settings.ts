/**
 * Settings → VMs from a project page (#307): "Manage in Settings" opens the
 * settings at its VM, and "Register this host as a VM" registers the host
 * first.
 *
 * Apart from `actions` because the settings' own actions reach the terminal
 * manager, and `actions` stays importable in node for its tests.
 */
import {dispatch} from '../../state/app-store';
import {openSettings} from '../settings/actions';
import {registerHost, VMS_SECTION_ID, vmRowId} from './actions';

/** The settings, scrolled to the VM, open to its controls. */
export async function openVmSettings(key: string): Promise<void> {
    dispatch({type: 'vmHostOpened', key});
    await openSettings();
    requestAnimationFrame(() => {
        const row = document.getElementById(vmRowId(key)) ?? document.getElementById(VMS_SECTION_ID);
        row?.scrollIntoView({block: 'start'});
    });
}

/** Register an agentless remote's host as a VM, then open the settings at it, with Install agent ready. */
export async function registerHostAsVm(host: {user: string; host: string; port: number}): Promise<void> {
    const key = await registerHost(host);
    if (key) await openVmSettings(key);
}

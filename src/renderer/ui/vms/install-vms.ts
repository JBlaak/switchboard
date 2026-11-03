/**
 * Settings → VMs' launch-time work (#307): read the list, read it again
 * whenever the settings open, and follow main's push.
 */
import {dispatch, onEvent} from '../../state/app-store';
import {loadVmHosts} from './actions';
import {vmApi} from './vm-api';

export function installVms(): void {
    // The list can have moved on while nobody looked; a missed push would show here.
    onEvent('settingsOpened', () => void loadVmHosts());
    vmApi().onVmHostsChanged?.((hosts) => {
        if (Array.isArray(hosts)) dispatch({type: 'vmHostsLoaded', hosts});
        else void loadVmHosts();
    });

    void loadVmHosts();
}

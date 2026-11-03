/**
 * Settings → VMs' launch-time work (#307): read the list, read it again
 * whenever the settings open, and follow main's push.
 */
import {onEvent} from '../../state/app-store';
import {loadVmHosts} from './actions';

export function installVms(): void {
    // The list can have moved on while nobody looked; a missed push would show here.
    onEvent('settingsOpened', () => void loadVmHosts());
    // Main's push carries no list; it says to read it again (the bridge turns it into this event).
    onEvent('vmHostsChanged', () => void loadVmHosts());

    void loadVmHosts();
}

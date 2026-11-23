/**
 * Opening the Schedule manager: from its figure on the empty screen, its
 * shortcut, the Automatic shelf, a run row. With a key, that schedule's page.
 */
import {dispatch} from '../../state/app-store';

export function openScheduleManager(key: string | null = null): void {
    dispatch({type: 'scheduleManagerPageRequested', key});
}

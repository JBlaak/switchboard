/**
 * The toolbar indicator's click: the settings, scrolled to Phone access.
 *
 * Apart from `actions` because the settings' own actions reach the terminal
 * manager, and `actions` stays importable in node for its tests.
 */
import { openSettings } from '../settings/actions';
import { PHONE_ACCESS_SECTION_ID } from './actions';

export async function openPhoneAccessSettings(): Promise<void> {
  await openSettings();
  requestAnimationFrame(() => {
    document.getElementById(PHONE_ACCESS_SECTION_ID)?.scrollIntoView({ block: 'start' });
  });
}

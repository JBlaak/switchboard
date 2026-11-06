/**
 * The Ask group's Edit: the settings, scrolled to the saved prompts (#344
 * builds that editor; until it is there, the settings open at the top).
 *
 * Apart from `actions` because the settings' own actions reach the terminal
 * manager, as `phone-access/open-settings` and `vms/open-settings` are.
 */
import {openSettings} from '../settings/actions';

/** The id the settings' saved-prompts section goes by, for Edit to scroll to. */
export const SAVED_PROMPTS_SECTION_ID = 'settings-saved-prompts';

export async function openSavedPromptsSettings(): Promise<void> {
    await openSettings();
    requestAnimationFrame(() => {
        document.getElementById(SAVED_PROMPTS_SECTION_ID)?.scrollIntoView({block: 'start'});
    });
}

/**
 * The session tray's "Edit" (#343): the settings, scrolled to Saved prompts.
 *
 * Apart from `saved-prompts-actions` because the settings' own actions reach
 * the terminal manager, and those stay importable in node for their tests.
 */
import {openSettings} from './actions';
import {SAVED_PROMPTS_SECTION_ID} from './saved-prompts-actions';

export async function openSavedPromptsSettings(): Promise<void> {
    await openSettings();
    requestAnimationFrame(() => {
        document.getElementById(SAVED_PROMPTS_SECTION_ID)?.scrollIntoView({block: 'start'});
    });
}

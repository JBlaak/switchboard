/**
 * Settings → Saved prompts (#344): reading every stored list and writing the
 * ones a change touched, through the saved-prompts channels (#339). Each write
 * replaces one list and keeps the rest of its settings blob, so the global
 * Save and a project page's settings leave the prompts alone and the other way
 * round.
 *
 * Writes go one after another, so a quick reorder lands in the order it was
 * made. A session's tray reads the lists when it opens, so a change shows
 * there at once.
 */
import {promptListsFrom} from './saved-prompts-editor';
import type {ListWrite, PromptLists} from './saved-prompts-editor';
import type {SavedPrompt} from '../../../domain/settings/saved-prompts';

/** The section's element, for opening the settings scrolled to it. */
export const SAVED_PROMPTS_SECTION_ID = 'settings-saved-prompts';

/** The global list and each of these projects' lists. */
export async function loadPromptLists(projectPaths: readonly string[]): Promise<PromptLists> {
    const [global, projects] = await Promise.all([
        window.api.savedPrompts(null).then((lists) => lists.global),
        Promise.all(
            projectPaths.map((projectPath) =>
                window.api
                    .savedPrompts(projectPath)
                    .then((lists) => ({projectPath, prompts: lists.project}))
                    .catch(() => ({projectPath, prompts: [] as SavedPrompt[]})),
            ),
        ),
    ]);
    return promptListsFrom(global, projects);
}

/** The writes in flight, one after another. */
let writes: Promise<void> = Promise.resolve();

/** Store each list a change touched. */
export function writePromptLists(lists: readonly ListWrite[]): Promise<void> {
    writes = writes
        .then(async () => {
            for (const {projectPath, prompts} of lists) await window.api.setSavedPrompts(projectPath, prompts);
        })
        .catch(() => undefined);
    return writes;
}

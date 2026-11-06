/**
 * What a project's settings view on its page does (#176): reading what the
 * project and the global settings store, storing each change as it is made,
 * and resetting to the global settings. Hiding the project is `hide-project`,
 * so this stays importable in node for its tests.
 *
 * Every write goes through the settings IPC under the project's key, which
 * `get-effective-settings` layers over the global blob when a session in the
 * project launches, so a change applies to the next session started there.
 * The rules for what a change stores are in `domain/settings/project-overrides`.
 */
import {dispatch, getState} from '../../state/app-store';
import {projectSettingsKey} from '../../../domain/settings/settings';
import {withProjectValue, withoutOverrides} from '../../../domain/settings/project-overrides';
import type {ProjectSettingField} from '../../../domain/settings/project-overrides';
import type {ProjectSettingsView, SettingsRecord} from '../../state/settings-slice';

/** The last read asked for: a slower, earlier one that lands after it is dropped. */
let latestLoad = 0;

/** Read the project's blob and the global one, for the view to show. */
export async function loadProjectSettings(projectPath: string): Promise<void> {
    const token = ++latestLoad;
    const [current, globalSettings] = await Promise.all([
        window.api.getSetting<SettingsRecord>(projectSettingsKey(projectPath)).then((found) => found || {}),
        window.api.getSetting<SettingsRecord>('global').then((found) => found || {}),
    ]);
    if (token !== latestLoad) return;
    dispatch({type: 'projectSettingsLoaded', projectPath, current, globalSettings});
}

/** Store one field's new value: an override, or none when it is the global value again. */
export function changeProjectSetting(projectPath: string, field: ProjectSettingField, value: unknown): Promise<void> {
    return store(projectPath, (view) => withProjectValue(view.globalSettings, view.current, field, value));
}

/** "Reset to global settings": the project overrides nothing any more. */
export function resetProjectSettings(projectPath: string): Promise<void> {
    return store(projectPath, (view) => withoutOverrides(view.current));
}

/** The writes in flight, one after another, so each builds on the blob the one before it wrote. */
let writes: Promise<void> = Promise.resolve();

/**
 * Write what `change` makes of the project's blob as stored now, then say it
 * is saved. Read afresh rather than taken from the copy the view loaded, so
 * what else writes to the blob meanwhile (its saved prompts, #344) is kept.
 */
function store(projectPath: string, change: (view: ProjectSettingsView) => SettingsRecord): Promise<void> {
    writes = writes
        .then(async () => {
            const view = getState().settings.project;
            if (!view || view.projectPath !== projectPath) return;
            const key = projectSettingsKey(projectPath);
            const stored = (await window.api.getSetting<SettingsRecord>(key)) || {};
            const next = change({...view, current: stored});
            await window.api.setSetting(key, next);
            dispatch({type: 'projectSettingsSaved', projectPath, current: next});
        })
        .catch(() => undefined);
    return writes;
}

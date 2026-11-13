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
import {withReleasesTagged, withWatchIssues} from '../../../domain/settings/inbox-settings';
import type {ProjectSettingField} from '../../../domain/settings/project-overrides';
import type {ProjectSettingsView, SettingsRecord} from '../../state/settings-slice';
import type {ReleaseTagsView} from '../../../application/services/inbox-settings-service';

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

/**
 * Watch issues on or off (#412). The project page's header switches it too,
 * without the settings view open, so it is written whether or not the view
 * shows this project.
 */
export function setWatchIssues(projectPath: string, on: boolean): Promise<void> {
    return updateProjectBlob(projectPath, (stored) => withWatchIssues(stored, on));
}

/** Releases are tagged (#412): yes, no, or back to what the tags say (null). */
export function setReleasesTagged(projectPath: string, value: boolean | null): Promise<void> {
    return updateProjectBlob(projectPath, (stored) => withReleasesTagged(stored, value));
}

/** Releases are tagged as main sees it (#412); null when it could not say. */
export function readReleaseTags(projectPath: string): Promise<ReleaseTagsView | null> {
    return window.api.releaseTags(projectPath).catch(() => null);
}

/** The project's blob as stored now, for what the page shows outside the settings view. */
export async function readProjectBlob(projectPath: string): Promise<SettingsRecord> {
    return (await window.api.getSetting<SettingsRecord>(projectSettingsKey(projectPath))) || {};
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

/**
 * Write what `change` makes of the project's blob as stored now, in turn
 * with the view's own writes. The view, when it shows this project, takes
 * the new blob and says it is saved.
 */
function updateProjectBlob(projectPath: string, change: (stored: SettingsRecord) => SettingsRecord): Promise<void> {
    writes = writes
        .then(async () => {
            const key = projectSettingsKey(projectPath);
            const stored = (await window.api.getSetting<SettingsRecord>(key)) || {};
            const next = change(stored);
            await window.api.setSetting(key, next);
            if (getState().settings.project?.projectPath === projectPath) {
                dispatch({type: 'projectSettingsSaved', projectPath, current: next});
            }
        })
        .catch(() => undefined);
    return writes;
}

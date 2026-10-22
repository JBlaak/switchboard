/**
 * What a project's settings view on its page does (#176): reading what the
 * project and the global settings store, storing each change as it is made,
 * resetting to the global settings, and hiding the project.
 *
 * Every write goes through the settings IPC under the project's key, which
 * `get-effective-settings` layers over the global blob when a session in the
 * project launches, so a change applies to the next session started there.
 * The rules for what a change stores are in `domain/settings/project-overrides`.
 */
import { dispatch, getState } from '../../state/app-store';
import { loadProjects } from '../../features/sessions/session-list';
import { projectLabel } from '../../features/sessions/project-label';
import { projectSettingsKey } from '../../../domain/settings/settings';
import { withProjectValue, withoutOverrides } from '../../../domain/settings/project-overrides';
import type { ProjectSettingField } from '../../../domain/settings/project-overrides';
import type { ProjectSettingsView, SettingsRecord } from '../../state/settings-slice';

/** The last read asked for: a slower, earlier one that lands after it is dropped. */
let latestLoad = 0;

/** Read the project's blob and the global one, for the view to show. */
export async function loadProjectSettings(projectPath: string): Promise<void> {
  const token = ++latestLoad;
  const [current, globalSettings] = await Promise.all([
    window.api.getSetting<SettingsRecord>(projectSettingsKey(projectPath)).then(found => found || {}),
    window.api.getSetting<SettingsRecord>('global').then(found => found || {}),
  ]);
  if (token !== latestLoad) return;
  dispatch({ type: 'projectSettingsLoaded', projectPath, current, globalSettings });
}

/** Store one field's new value: an override, or none when it is the global value again. */
export function changeProjectSetting(projectPath: string, field: ProjectSettingField, value: unknown): Promise<void> {
  return store(projectPath, view => withProjectValue(view.globalSettings, view.current, field, value));
}

/** "Reset to global settings": the project overrides nothing any more. */
export function resetProjectSettings(projectPath: string): Promise<void> {
  return store(projectPath, view => withoutOverrides(view.current));
}

/**
 * Hide the project from Switchboard, after asking. Its session files stay on
 * disk; it just stops being listed, so its page gives way to the empty screen.
 */
export async function hideProjectFromPage(projectPath: string): Promise<void> {
  if (!confirm(`Hide ${projectLabel(projectPath)}?\n\nSession files are not deleted. Add the folder again to bring it back.`)) return;
  await window.api.removeProject(projectPath);
  dispatch({ type: 'screenCleared' });
  void loadProjects();
}

/** The writes in flight, one after another, so each builds on the blob the one before it wrote. */
let writes: Promise<void> = Promise.resolve();

/** Write what `change` makes of the project's blob as last written, then say it is saved. */
function store(projectPath: string, change: (view: ProjectSettingsView) => SettingsRecord): Promise<void> {
  writes = writes.then(async () => {
    const view = getState().settings.project;
    if (!view || view.projectPath !== projectPath) return;
    const next = change(view);
    await window.api.setSetting(projectSettingsKey(projectPath), next);
    dispatch({ type: 'projectSettingsSaved', projectPath, current: next });
  }).catch(() => undefined);
  return writes;
}

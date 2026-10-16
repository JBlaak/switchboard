/**
 * The settings panel's entry points for the vanilla code that opens it: the
 * toolbar gear, a project picker row, a quick session with no folder yet.
 *
 * The panel itself is React (`ui/settings`); these stay so their callers did
 * not have to change, and go once those callers move too.
 */
import { closeSettings, openSettings } from '../../ui/settings/actions';

export function openSettingsViewer(scope: 'global' | 'project', projectPath?: string): Promise<void> {
  return openSettings(scope, projectPath);
}

export function closeSettingsViewer(): void {
  closeSettings();
}

/**
 * A quick session: a Claude session in one fixed folder, no picker.
 *
 * The folder is the `quickSessionPath` global setting. Until one is set there
 * is nowhere to launch: the lightning bolt is hidden, and the shortcuts open
 * global settings instead of doing nothing silently.
 */
import { dispatch } from '../../state/app-store';
import { openSettings } from '../../ui/settings/actions';
import { launchClaudeSession, projectStub } from './session-actions';

export { isBareQuickSessionKey, isQuickSessionKey } from '../../lib/shortcut-keys';

export async function launchQuickSession(): Promise<void> {
  const path = await quickSessionPath();
  if (!path) {
    await openSettings();
    return;
  }
  await launchClaudeSession(projectStub(path));
}

/**
 * Show the lightning bolt only while there is a folder for it to launch in.
 *
 * Re-read after a settings save, which is how the folder changes.
 */
export async function syncQuickSessionButton(): Promise<void> {
  dispatch({ type: 'quickSessionPathRead', path: await quickSessionPath() });
}

async function quickSessionPath(): Promise<string> {
  const global = await window.api.getSetting<Record<string, unknown>>('global');
  return typeof global?.quickSessionPath === 'string' ? global.quickSessionPath.trim() : '';
}

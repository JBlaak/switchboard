/**
 * The "new version" line at the bottom of the sessions sidebar.
 *
 * Quiet on purpose: one line of footer text with an Install button, no badge,
 * no dialog. It appears when main finds a newer release, and the × hides it
 * until a later version turns up. Installing quits the app, which stops every
 * running session, so that is asked first when any are running.
 *
 * When the app cannot replace itself (a dev build, or a copy in a folder it
 * cannot write to), the button opens the release page instead.
 */
import { onEvent } from '../../state/app-store';
import { view } from '../../state/session-store';
import type { UpdateNotice } from '../../../domain/update/release';

export function installUpdateNotice(): void {
  const root = document.getElementById('update-notice');
  const label = document.getElementById('update-notice-label');
  const action = document.getElementById('update-notice-action') as HTMLButtonElement | null;
  const dismiss = document.getElementById('update-notice-dismiss');
  if (!root || !label || !action || !dismiss) return;

  let current: UpdateNotice | null = null;
  let dismissed: string | null = null;

  const render = (): void => {
    root.hidden = !current || current.version === dismissed;
    if (!current) return;
    label.textContent = `Version ${current.version} is available`;
    action.textContent = current.installable ? 'Install' : 'View';
    action.title = current.installable
      ? 'Download, replace this app and restart'
      : 'Open the release page';
  };

  const show = (update: UpdateNotice | null): void => {
    current = update;
    render();
  };

  action.addEventListener('click', async () => {
    if (!current || action.disabled) return;
    if (!current.installable) {
      void window.api.openExternal(current.pageUrl);
      return;
    }
    const running = view.activePtyIds.size;
    if (running > 0 && !confirm(
      `Restarting to update stops ${running} running session${running === 1 ? '' : 's'}. Install now?`,
    )) return;

    action.disabled = true;
    action.textContent = 'Installing…';
    // On success the app quits from under this; an answer means it did not.
    const ok = await window.api.installUpdate();
    if (!ok) {
      action.disabled = false;
      label.textContent = 'Update failed';
      action.textContent = 'Retry';
    }
  });

  dismiss.addEventListener('click', () => {
    dismissed = current?.version ?? null;
    render();
  });

  onEvent('updateAvailable', ({ update }) => show(update));
  void window.api.getUpdate().then(show);
}

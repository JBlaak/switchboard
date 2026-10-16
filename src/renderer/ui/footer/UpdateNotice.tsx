/**
 * The "new version" line at the top of the footer.
 *
 * Quiet on purpose: one line of footer text with an Install button, no badge,
 * no dialog. It appears when main finds a newer release, and the × hides it
 * until a later version turns up. Installing quits the app, which stops every
 * running session, so that is asked first (see `installUpdate`).
 *
 * When the app cannot replace itself (a dev build, or a copy in a folder it
 * cannot write to), the button opens the release page instead.
 */
import { visibleUpdate } from '../../state/update-slice';
import { useStore } from '../use-store';
import { dismissUpdate, installUpdate, openReleasePage } from './actions';
import type { JSX } from 'react';

export function UpdateNotice(): JSX.Element | null {
  const notice = useStore(state => visibleUpdate(state.update));
  const installing = useStore(state => state.update.installing);
  const failed = useStore(state => state.update.failed);
  if (!notice) return null;

  const action = installing ? 'Installing…' : failed ? 'Retry' : notice.installable ? 'Install' : 'View';
  return (
    <div id="update-notice">
      <span id="update-notice-label">
        {failed ? 'Update failed' : `Version ${notice.version} is available`}
      </span>
      <button
        id="update-notice-action"
        type="button"
        disabled={installing}
        title={notice.installable ? 'Download, replace this app and restart' : 'Open the release page'}
        onClick={notice.installable ? () => void installUpdate() : openReleasePage}
      >
        {action}
      </button>
      <button
        id="update-notice-dismiss"
        type="button"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => dismissUpdate(notice.version)}
      >
        &times;
      </button>
    </div>
  );
}

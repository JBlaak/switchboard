/**
 * The global settings panel: a header that doubles as the window's drag
 * region, and the form. A project's own settings are on its page (#176).
 *
 * Rendered into `#settings-viewer`, which stays in `index.html` because the
 * main area's panel swap, which decides when it shows, is imperative (see
 * `actions`). The form is
 * keyed on the open, so each open starts from what is stored.
 */
import { useStore } from '../use-store';
import { SettingsForm } from './SettingsForm';
import type { JSX } from 'react';

export function SettingsViewer(): JSX.Element {
  const panel = useStore(state => state.settings.panel);
  return (
    <>
      <div id="settings-viewer-header">
        <span id="settings-viewer-title">{panel ? 'Global Settings' : 'Settings'}</span>
      </div>
      <div id="settings-viewer-body">
        {panel && <SettingsForm key={panel.openId} panel={panel} />}
      </div>
    </>
  );
}

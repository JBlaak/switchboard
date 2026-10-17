/**
 * The settings panel: a header that doubles as the window's drag region, and
 * the form for whichever scope is open.
 *
 * Rendered into `#settings-viewer`, which stays in `index.html` because the
 * main area's panel swap, which decides when it shows, is imperative (see
 * `actions`). The form is
 * keyed on the open, so each open starts from what is stored.
 */
import { shortProjectPath } from '../../../domain/project/project-path';
import { useStore } from '../use-store';
import { SettingsForm } from './SettingsForm';
import type { JSX } from 'react';
import type { SettingsPanel } from '../../state/settings-slice';

function title(panel: SettingsPanel | null): string {
  if (!panel) return 'Settings';
  return panel.scope === 'project'
    ? 'Project Settings — ' + shortProjectPath(panel.projectPath)
    : 'Global Settings';
}

export function SettingsViewer(): JSX.Element {
  const panel = useStore(state => state.settings.panel);
  return (
    <>
      <div id="settings-viewer-header">
        <span id="settings-viewer-title">{title(panel)}</span>
      </div>
      <div id="settings-viewer-body">
        {panel && <SettingsForm key={panel.openId} panel={panel} />}
      </div>
    </>
  );
}

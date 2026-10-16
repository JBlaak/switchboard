/**
 * The one React root, mounted beside the vanilla UI.
 *
 * It renders nothing of its own. Surfaces move over one at a time, and each
 * renders into the container it already has in `index.html` through a
 * `Portal` from here — so the markup and its styles stay where they are, and a
 * single root keeps one tree, one StrictMode and one place to add context.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toolbar } from './toolbar/Toolbar';
import { Dialogs } from './dialogs/Dialogs';
import { Portal } from './Portal';
import { Footer } from './footer/Footer';
import { SettingsViewer } from './settings/SettingsViewer';
import { SessionList } from './session-list/SessionList';
import type { JSX } from 'react';
import type { Root as ReactRoot } from 'react-dom/client';

/** The surfaces ported so far, each a `<Portal>` into its container. */
export function Root(): JSX.Element | null {
  return (
    <>
      <Toolbar />
      <Dialogs />
      <Portal target="settings-viewer"><SettingsViewer /></Portal>
      <Portal target="sidebar-footer"><Footer /></Portal>
      <Portal target="sidebar-content"><SessionList /></Portal>
    </>
  );
}

/**
 * Mount the root in a host element of its own.
 *
 * The host is hidden and empty: the root's own children are portals, which
 * render into their target containers, not into the host. Answers the root so
 * a hot reload can unmount it.
 */
export function mountReactRoot(): ReactRoot {
  const host = document.createElement('div');
  host.id = 'react-root';
  host.hidden = true;
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<StrictMode><Root /></StrictMode>);
  return root;
}

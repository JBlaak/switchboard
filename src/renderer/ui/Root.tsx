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
import type { JSX } from 'react';
import type { Root as ReactRoot } from 'react-dom/client';
import { Portal } from './Portal';
import { TerminalHost } from './terminal/TerminalHost';
import { TerminalHeaderControls, TerminalHeaderInfo } from './terminal/TerminalHeader';

/** The surfaces ported so far, each a `<Portal>` into its container. */
export function Root(): JSX.Element | null {
  return (
    <>
      <Portal target="terminals"><TerminalHost /></Portal>
      <Portal target="terminal-header-info"><TerminalHeaderInfo /></Portal>
      <Portal target="terminal-header-controls"><TerminalHeaderControls /></Portal>
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

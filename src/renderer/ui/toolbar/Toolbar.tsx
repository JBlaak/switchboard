/**
 * The sidebar's chrome, as one surface: the header (toolbar and filter row),
 * the search box, the expand button of the collapsed rail, and the resize
 * handle.
 *
 * The session list between them is a surface of its own, so each piece
 * portals into its own container in `index.html` rather than owning the
 * sidebar.
 */
import { useLayoutEffect } from 'react';
import { Portal } from '../Portal';
import { useStore } from '../use-store';
import { SearchBar, SEARCH_BAR_ID } from './SearchBar';
import { SessionFilters } from './SessionFilters';
import { SidebarResize } from './SidebarResize';
import { SidebarToolbar } from './SidebarToolbar';
import { SidebarExpandIcon } from './icons';
import { setSidebarCollapsed } from './actions';
import type { JSX } from 'react';

/**
 * `#sidebar.collapsed` is what the stylesheet hides the rest of the sidebar
 * by. The sidebar element is static markup in `index.html`, not this tree's,
 * so the class is set on it from here.
 */
function useCollapsedClass(): void {
  const collapsed = useStore(s => s.toolbar.sidebarCollapsed);
  useLayoutEffect(() => {
    document.getElementById('sidebar')?.classList.toggle('collapsed', collapsed);
  }, [collapsed]);
}

export function Toolbar(): JSX.Element {
  useCollapsedClass();
  return (
    <>
      <Portal target="sidebar-header">
        <SidebarToolbar />
        <SessionFilters />
      </Portal>
      <Portal target={SEARCH_BAR_ID}>
        <SearchBar />
      </Portal>
      {/* Shown only on the collapsed rail, where it is the sidebar's one visible child. */}
      <Portal target="sidebar">
        <button id="sidebar-expand-btn" title="Show sidebar" onClick={() => setSidebarCollapsed(false)}>
          <SidebarExpandIcon />
        </button>
      </Portal>
      <SidebarResize />
    </>
  );
}

/**
 * The sidebar's chrome, as one surface: the header (toolbar and filter row),
 * the search box, the expand button of the collapsed rail, and the resize
 * handle.
 *
 * The session list between them is a surface of its own, so each piece
 * portals into its own container in `index.html` rather than owning the
 * sidebar.
 */
import { useLayoutEffect, useRef } from 'react';
import { Portal } from '../Portal';
import { useStore } from '../use-store';
import { SearchBar, SEARCH_BAR_ID } from './SearchBar';
import { SessionFilters } from './SessionFilters';
import { SidebarResize } from './SidebarResize';
import { SidebarToolbar } from './SidebarToolbar';
import { SidebarExpandIcon } from './icons';
import { refitActiveTerminal, setSidebarCollapsed } from './actions';
import type { JSX } from 'react';

/** Matches the `#sidebar.animating` transition in `_main-area.scss`. */
const SIDEBAR_SLIDE_MS = 240;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * `#sidebar.collapsed` is what the stylesheet hides the rest of the sidebar
 * by. The sidebar element is static markup in `index.html`, not this tree's,
 * so the class is set on it from here.
 *
 * A toggle also sets `.animating` for the length of the slide, which is what
 * turns the width transition on: left on, it would also animate a drag of the
 * resize handle and the stored width being applied at boot. The terminal is
 * refitted once the slide ends, since xterm measures its grid in pixels.
 */
function useCollapsedClass(): void {
  const collapsed = useStore(s => s.toolbar.sidebarCollapsed);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed', collapsed);
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reducedMotion.matches) {
      refitActiveTerminal();
      return;
    }
    sidebar.classList.add('animating');
    // A toggle mid-slide cancels this one's cleanup, so it reverses rather than snaps.
    const done = setTimeout(() => {
      sidebar.classList.remove('animating');
      refitActiveTerminal();
    }, SIDEBAR_SLIDE_MS);
    return () => clearTimeout(done);
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

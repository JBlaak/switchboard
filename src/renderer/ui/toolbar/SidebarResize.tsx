/**
 * Dragging the sidebar's edge.
 *
 * The handle stays static markup in `index.html`: the stylesheet hides it
 * through `#sidebar.collapsed + #sidebar-resize-handle`, so it has to remain
 * the sidebar's next sibling, which a portal (it appends) cannot promise. This
 * renders nothing and wires the existing element instead.
 *
 * The move and release listeners are on `window`, not the handle: a fast drag
 * leaves the pointer behind, and a handle-scoped listener would drop it. The
 * width is persisted on release rather than during the drag, which would write
 * a setting per frame, and the terminal refits then too.
 */
import { useEffect } from 'react';
import { persistSidebarWidth, refitActiveTerminal } from './actions';

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 600;

export function SidebarResize(): null {
  useEffect(() => {
    const sidebar = document.getElementById('sidebar');
    const handle = document.getElementById('sidebar-resize-handle');
    if (!sidebar || !handle) return;
    let dragging = false;

    const release = (): void => {
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    const onDown = (e: MouseEvent): void => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      // Otherwise the drag selects the text either side of the handle.
      document.body.style.userSelect = 'none';
    };

    const onMove = (e: MouseEvent): void => {
      if (!dragging) return;
      const width = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, e.clientX));
      sidebar.style.width = width + 'px';
    };

    const onUp = (): void => {
      if (!dragging) return;
      release();
      refitActiveTerminal();
      const width = parseInt(sidebar.style.width, 10);
      if (width) void persistSidebarWidth(width);
    };

    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      handle.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (dragging) release();
    };
  }, []);

  return null;
}

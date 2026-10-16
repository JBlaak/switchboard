/**
 * Render into an existing container of the vanilla page.
 *
 * How a surface moves to React without moving in the DOM: the root stays one
 * tree, and each ported surface portals into the element `index.html` (or
 * vanilla code) already gives it, found by id. While the target is missing —
 * a container the vanilla code has not built yet — nothing renders, rather
 * than throwing.
 */
import { createPortal } from 'react-dom';
import type { JSX, ReactNode } from 'react';

export interface PortalProps {
  /** The id of the element to render into. */
  target: string;
  children: ReactNode;
}

export function Portal({ target, children }: PortalProps): JSX.Element | null {
  const container = document.getElementById(target);
  return container ? createPortal(children, container) : null;
}

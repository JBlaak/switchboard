/**
 * Render into an existing container of the page.
 *
 * How a surface lives in React without owning the layout: the root stays one
 * tree, and each surface portals into the element `index.html` gives it,
 * found by id. While the target is missing nothing renders, rather than
 * throwing.
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

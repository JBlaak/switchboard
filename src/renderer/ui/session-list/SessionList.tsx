/**
 * The session list: one flat list across every project, in sections, with the
 * rows that are too old folded behind "+ N older", and the space under it.
 *
 * Rendered into `#sidebar-content`, which stays the scrolling container — so
 * the scroll position is never touched by a redraw — and stays the element
 * the keyboard navigation focuses and listens on.
 *
 * What is laid out where comes from the last redraw (`sessionList.layout`);
 * see `session-list-slice` for why the order is not recomputed on every
 * render.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { TIER_LABELS } from '../../../domain/session/tiers';
import { sidebarContent } from '../../lib/dom';
import { useStore } from '../use-store';
import { clearScreenFromList, toggleOlder } from './actions';
import { installDragSpace } from './drag-space';
import { restoreTerminalFocus } from './focus';
import { SessionItem } from './SessionItem';
import { SlugGroup } from './SlugGroup';
import { useReflow } from './use-reflow';
import type { JSX } from 'react';
import type { LaidEntry } from '../../state/session-list-layout';

export function SessionList(): JSX.Element | null {
  const layout = useStore(s => s.sessionList.layout);
  const revision = useStore(s => s.sessionList.revision);
  const olderExpanded = useStore(s => s.sessionList.olderExpanded);
  const olderCursor = useStore(s => s.sessionList.cursor === 'older-all');

  useReflow(sidebarContent, revision);

  // After each redraw the terminal gets the keyboard back (see `restoreTerminalFocus`).
  useLayoutEffect(() => {
    if (revision > 0) restoreTerminalFocus();
  }, [revision]);

  // The empty space is the container's own, padding included, so the click is
  // heard there rather than on anything this tree renders.
  useEffect(() => {
    const onClick = (e: MouseEvent): void => clearScreenFromList(e.target as Element);
    sidebarContent.addEventListener('click', onClick);
    return () => sidebarContent.removeEventListener('click', onClick);
  }, []);

  // The blank space below the list also drags the window. It only renders once
  // there is a layout, so that is when it is watched.
  const dragSpace = useRef<HTMLDivElement>(null);
  useEffect(() => (dragSpace.current ? installDragSpace(dragSpace.current) : undefined), [layout !== null]);

  const noProjects = useStore(s => s.toolbar.hasProjects === false);

  if (!layout) return noProjects ? <FirstRunHint /> : null;
  const { visible, older, filtering } = layout;

  return (
    <>
      <div className="session-list" id="session-list">
        {noProjects && <FirstRunHint />}
        {sections(visible, filtering)}
        {older.length > 0 && (
          <>
            <div
              className={'sessions-more-toggle' + (olderExpanded ? ' expanded' : '') + (olderCursor ? ' kbd-cursor' : '')}
              id="older-all"
              onClick={toggleOlder}
            >
              {olderExpanded ? '- hide older' : `+ ${older.length} older`}
            </div>
            <div className="sessions-older" id="older-list-all" style={olderExpanded ? undefined : { display: 'none' }}>
              {older.map(laid => <Entry key={laid.entry.id} laid={laid} />)}
            </div>
          </>
        )}
      </div>
      {/* Fills whatever height the list leaves free: a click there puts the session away, a drag moves the window. */}
      <div id="sidebar-drag-space" data-testid="sidebar-drag-space" ref={dragSpace} />
    </>
  );
}

/**
 * The entries with a label at the head of each section. Section labels only
 * make sense in the unfiltered view; a filtered list is already one answer to
 * one question.
 */
function sections(visible: readonly LaidEntry[], filtering: boolean): JSX.Element[] {
  const out: JSX.Element[] = [];
  let lastTier: number | null = null;
  for (const laid of visible) {
    if (!filtering && laid.tier !== lastTier) {
      out.push(
        <div key={'section-' + laid.tier} className="session-section-label" id={'section-' + laid.tier}>
          {TIER_LABELS[laid.tier]}
        </div>,
      );
      lastTier = laid.tier;
    }
    out.push(<Entry key={laid.entry.id} laid={laid} />);
  }
  return out;
}

/** With no project at all, where to start: the Projects button above, which carries a dot (#171). */
function FirstRunHint(): JSX.Element {
  return (
    <p className="session-list-first-run">
      No sessions yet. Add a project with the Projects button above, or press <kbd className="sw-kbd">⌘A</kbd>.
    </p>
  );
}

function Entry({ laid }: { laid: LaidEntry }): JSX.Element {
  return laid.entry.kind === 'group'
    ? <SlugGroup group={laid.entry} />
    : <SessionItem row={laid.entry} />;
}

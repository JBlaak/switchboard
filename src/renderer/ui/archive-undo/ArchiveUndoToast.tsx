/**
 * "Archived “<name>” · Undo", for a few seconds after you archive here.
 *
 * It floats at the foot of the main area, above the Mark done offer when that
 * comes too (see `MainFloats`), and leaves the focus where it is: keyboard
 * archiving goes on from the list, and ⌘Z undoes it from there (see
 * `app/shortcuts`). The timer waits while the pointer is over it.
 */
import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useStore } from '../use-store';
import { closeArchiveUndo, undoArchive } from './actions';

/** How long the toast stays up. */
export const ARCHIVE_UNDO_MS = 6000;

export function ArchiveUndoToast(): JSX.Element | null {
  const undo = useStore(state => state.archiveUndo.undo);
  const [hovered, setHovered] = useState(false);
  const id = undo?.id ?? null;

  useEffect(() => {
    if (id === null || hovered) return;
    // Starts afresh as the pointer leaves, so it never vanishes from under a reach for Undo.
    const timer = setTimeout(() => closeArchiveUndo(id), ARCHIVE_UNDO_MS);
    return () => clearTimeout(timer);
  }, [id, hovered]);

  if (!undo) return null;

  return (
    <div
      key={undo.id}
      className="archive-undo"
      role="status"
      data-testid="archive-undo"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="archive-undo-text">
        Archived <span className="archive-undo-label">{undo.label}</span>
      </span>
      <button type="button" className="sw-btn archive-undo-btn" onClick={() => void undoArchive()}>
        Undo <kbd className="st-offer-kbd">⌘Z</kbd>
      </button>
      <button type="button" className="archive-undo-close" aria-label="Dismiss" onClick={() => closeArchiveUndo(undo.id)}>
        ✕
      </button>
    </div>
  );
}

/**
 * Renaming a session in place: the row's label, swapped for an input.
 *
 * Not a dialog: the name is one short string, and the list keeps redrawing
 * around it. The input lives in state (`renaming`), so a redraw renders it
 * again rather than discarding what is being typed.
 *
 * Enter or leaving the input saves; Escape cancels without saving. Once one of
 * them has happened the input ignores the rest — closing the input moves the
 * focus, and the blur that follows must not save a cancelled rename.
 */
import { useLayoutEffect, useRef } from 'react';
import { fallbackName } from '../../state/session-list-layout';
import { sessionMap } from '../../state/session-store';
import { cancelRename, finishRename } from './actions';
import type { JSX } from 'react';
import type { SessionRow } from '../../../domain/session/session';

export interface RenameInputProps {
  rowId: string;
  /** The layout's copy; the shared row, if there is one, has the latest name. */
  session: SessionRow;
}

export function RenameInput({ rowId, session }: RenameInputProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  // Focused with its text selected, ready to be typed over.
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const current = sessionMap.get(session.sessionId) ?? session;

  const save = (): void => {
    if (done.current || !input.current) return;
    done.current = true;
    void finishRename(rowId, session.sessionId, input.current.value);
  };

  return (
    <input
      ref={input}
      type="text"
      className="session-rename-input"
      defaultValue={current.name || fallbackName(current)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
          return;
        }
        if (e.key !== 'Escape') return;
        done.current = true;
        cancelRename(rowId);
      }}
    />
  );
}

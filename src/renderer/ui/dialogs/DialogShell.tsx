/**
 * The scaffolding every dialog in the app shares.
 *
 * A modal overlay, Escape and click-outside to dismiss, and Enter to submit.
 * Each dialog then only writes the part that is actually its own.
 *
 * The overlay goes straight into `document.body`, where the vanilla shell
 * appended it, rather than through `Portal`: there is no container for it in
 * `index.html` to find by id, and the stylesheet positions it against the
 * page as a whole.
 *
 * Focus is not handed back to what had it before the dialog opened. That is
 * how the vanilla dialogs behaved, and adding it would be a change of its own.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { JSX, MouseEvent, ReactNode } from 'react';

export interface DialogShellProps {
  /** Class on the backdrop; the stylesheet keys the animation off it. */
  overlayClass: string;
  dialogClass: string;
  onClose(): void;
  /** Called when Enter is pressed outside a text input (see `submitFromInputs`). */
  onSubmit?(): void;
  /**
   * Let Enter submit from inside a text field too.
   *
   * Right for a dialog whose fields are one short value each — typing a path
   * and pressing Enter is the whole interaction — and wrong for one where Enter
   * would fire while the user is still filling in the form.
   */
  submitFromInputs?: boolean;
  children: ReactNode;
}

export function DialogShell({
  overlayClass, dialogClass, onClose, onSubmit, submitFromInputs = false, children,
}: DialogShellProps): JSX.Element {
  // The handlers are read through a ref so the key listener is added once per
  // dialog, not again on every render that hands it a new closure.
  const handlers = useRef({ onClose, onSubmit, submitFromInputs });
  handlers.current = { onClose, onSubmit, submitFromInputs };

  // On `document` rather than the dialog, so Escape works regardless of what
  // has focus — and removed when the dialog unmounts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { onClose: close, onSubmit: submit, submitFromInputs: fromInputs } = handlers.current;
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (e.key !== 'Enter' || !submit) return;
      if (fromInputs || !(e.target as HTMLElement).matches('input')) submit();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const onBackdrop = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return createPortal(
    <div className={overlayClass} onClick={onBackdrop}>
      <div className={dialogClass}>{children}</div>
    </div>,
    document.body,
  );
}

/**
 * An instant hover label, as props for an icon-only button.
 *
 * The native `title` tooltip takes a beat to appear and is easy to miss on an
 * icon-only button, so the stylesheet paints its own off `data-tooltip`; the
 * same text is the button's accessible name.
 */
export function tooltip(text: string): { 'data-tooltip': string; 'aria-label': string } {
  return { 'data-tooltip': text, 'aria-label': text };
}

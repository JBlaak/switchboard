/**
 * The scaffolding every dialog in the app shares.
 *
 * A modal overlay, Escape and click-outside to dismiss, and a lookup for the
 * controls inside it. Each dialog then only writes the part that is actually
 * its own — which is what stopped four copies of the same close-and-unbind
 * dance drifting apart.
 */

export interface DialogHandle {
  overlay: HTMLElement;
  dialog: HTMLElement;
  close(): void;
  /** Look up a control this dialog's own markup declares. */
  field<T extends HTMLElement = HTMLInputElement>(selector: string): T;
  /** Called when Enter is pressed outside a text input. */
  onSubmit(handler: () => void): void;
}

export interface DialogOptions {
  /** Class on the backdrop; the stylesheet keys the animation off it. */
  overlayClass: string;
  dialogClass: string;
  html: string;
  /**
   * Let Enter submit from inside a text field too.
   *
   * Right for a dialog whose fields are one short value each — typing a path
   * and pressing Enter is the whole interaction — and wrong for one where Enter
   * would fire while the user is still filling in the form.
   */
  submitFromInputs?: boolean;
}

/**
 * Open a modal dialog.
 *
 * The keydown listener is on `document` rather than the dialog, so Escape works
 * regardless of what inside it has focus — and it is removed on close, which is
 * why closing goes through the returned handle rather than removing the element.
 */
export function openDialog({
  overlayClass, dialogClass, html, submitFromInputs = false,
}: DialogOptions): DialogHandle {
  const overlay = document.createElement('div');
  overlay.className = overlayClass;

  const dialog = document.createElement('div');
  dialog.className = dialogClass;
  dialog.innerHTML = html;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  let submit: (() => void) | null = null;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key !== 'Enter' || !submit) return;
    if (submitFromInputs || !(e.target as HTMLElement).matches('input')) submit();
  };

  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === overlay) close();
  });

  return {
    overlay,
    dialog,
    close,
    field<T extends HTMLElement = HTMLInputElement>(selector: string): T {
      const found = dialog.querySelector<T>(selector);
      // The markup is written a few lines above every call, so a miss is a bug
      // in the template rather than a runtime condition worth branching on.
      if (!found) throw new Error(`dialog is missing ${selector}`);
      return found;
    },
    onSubmit(handler: () => void): void {
      submit = handler;
    },
  };
}

/**
 * An instant hover label.
 *
 * The native `title` tooltip takes a beat to appear and is easy to miss on an
 * icon-only button, so the dialogs paint their own off this attribute.
 */
export function setTooltip(element: HTMLElement, text: string): void {
  element.dataset.tooltip = text;
  element.setAttribute('aria-label', text);
}

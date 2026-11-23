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
import {useEffect, useRef} from 'react';
import {createPortal} from 'react-dom';
import type {JSX, MouseEvent, ReactNode} from 'react';

export interface DialogShellProps {
    /** Class on the backdrop; the stylesheet keys the animation off it. */
    overlayClass: string;
    dialogClass: string;
    onClose(): void;
    /** What Escape does, when not closing: a step back in a dialog of steps. Defaults to `onClose`. */
    onEscape?(): void;
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
    /**
     * Keep Tab and Shift-Tab inside the dialog, wrapping from its last control
     * to its first and back, so the keyboard cannot wander to the page under it.
     */
    trapFocus?: boolean;
    children: ReactNode;
}

/** What Tab can land on. */
const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export function DialogShell({
    overlayClass,
    dialogClass,
    onClose,
    onEscape,
    onSubmit,
    submitFromInputs = false,
    trapFocus = false,
    children,
}: DialogShellProps): JSX.Element {
    // The handlers are read through a ref so the key listener is added once per
    // dialog, not again on every render that hands it a new closure.
    const handlers = useRef({onClose, onEscape, onSubmit, submitFromInputs, trapFocus});
    handlers.current = {onClose, onEscape, onSubmit, submitFromInputs, trapFocus};
    const dialog = useRef<HTMLDivElement>(null);

    // On `document` rather than the dialog, so Escape works regardless of what
    // has focus — and removed when the dialog unmounts.
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            const {onClose: close, onEscape: escape, onSubmit: submit, submitFromInputs: fromInputs} = handlers.current;
            if (e.key === 'Escape') {
                (escape ?? close)();
                return;
            }
            if (e.key === 'Tab') {
                if (handlers.current.trapFocus && dialog.current) keepTabInside(dialog.current, e);
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
            <div ref={dialog} className={dialogClass}>
                {children}
            </div>
        </div>,
        document.body,
    );
}

/** Wrap Tab from the last control to the first (and Shift-Tab back), and pull a stray focus back in. */
function keepTabInside(dialog: HTMLElement, e: KeyboardEvent): void {
    const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.getClientRects().length > 0,
    );
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && dialog.contains(active);
    if (!inside || (e.shiftKey && active === first) || (!e.shiftKey && active === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
    }
}

/**
 * An instant hover label, as props for an icon-only button.
 *
 * The native `title` tooltip takes a beat to appear and is easy to miss on an
 * icon-only button, so the stylesheet paints its own off `data-tooltip`; the
 * same text is the button's accessible name.
 */
export function tooltip(text: string): {'data-tooltip': string; 'aria-label': string} {
    return {'data-tooltip': text, 'aria-label': text};
}

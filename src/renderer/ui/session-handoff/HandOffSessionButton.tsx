/**
 * Hand off to… for one session (#276 stage 3), in a row's actions and in the
 * terminal header.
 *
 * Shown only where `canHandOffSession` allows it, which the caller decides.
 * With one host it opens the dialog at once; with several a small menu picks
 * one, hanging below the button in a portal on the body, out of the row's
 * clipped action strip, as the snooze menu does. The menu goes on a choice,
 * Escape, a click elsewhere or a scroll.
 */
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {handOffOpens} from '../project-page/handoff-view';
import {openSessionHandOff} from '../dialogs/session-handoff-actions';
import type {JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent} from 'react';
import type {HandoffHost} from '../../../application/services/project-handoff';

export interface HandOffSessionButtonProps {
    sessionId: string;
    hosts: readonly HandoffHost[];
    className: string;
    id?: string;
    /** The button's inside, as markup (the row's icons are strings); its text when absent. */
    html?: {__html: string};
    /** Told when the host menu opens and closes, so a row keeps its action strip up meanwhile. */
    onMenu?(open: boolean): void;
}

export function HandOffSessionButton({
    sessionId,
    hosts,
    className,
    id,
    html,
    onMenu,
}: HandOffSessionButtonProps): JSX.Element {
    const button = useRef<HTMLButtonElement>(null);
    const [picking, setPicking] = useState(false);

    const setMenu = useCallback(
        (open: boolean) => {
            setPicking(open);
            onMenu?.(open);
        },
        [onMenu],
    );
    const closeMenu = useCallback(() => setMenu(false), [setMenu]);

    const onClick = (e: ReactMouseEvent<HTMLButtonElement>): void => {
        // A row's click opens the session; this one is the button's own.
        e.stopPropagation();
        const opens = handOffOpens(hosts);
        if (opens.kind === 'dialog') void openSessionHandOff(sessionId, opens.host);
        else setMenu(!picking);
    };

    const attributes = {
        id,
        type: 'button' as const,
        className,
        title: 'Hand off to…',
        'aria-haspopup': hosts.length > 1 ? ('menu' as const) : undefined,
        'aria-expanded': hosts.length > 1 ? picking : undefined,
        onClick,
    };

    return (
        <>
            {html ? (
                <button ref={button} {...attributes} dangerouslySetInnerHTML={html} />
            ) : (
                <button ref={button} {...attributes}>
                    Hand off to…
                </button>
            )}
            {picking && button.current && (
                <HostMenu
                    anchor={button.current}
                    hosts={hosts}
                    onClose={closeMenu}
                    onPick={(host) => {
                        closeMenu();
                        void openSessionHandOff(sessionId, host);
                    }}
                />
            )}
        </>
    );
}

interface HostMenuProps {
    anchor: HTMLElement;
    hosts: readonly HandoffHost[];
    onPick(host: HandoffHost): void;
    onClose(): void;
}

function HostMenu({anchor, hosts, onPick, onClose}: HostMenuProps): JSX.Element {
    const menu = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState<{top: number; right: number} | null>(null);

    useLayoutEffect(() => {
        const r = anchor.getBoundingClientRect();
        setPlace({top: r.bottom + 4, right: window.innerWidth - r.right});
    }, [anchor]);

    useEffect(() => {
        menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
        const onDown = (e: MouseEvent): void => {
            const target = e.target as Node;
            if (!menu.current?.contains(target) && !anchor.contains(target)) onClose();
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
        };
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('scroll', onClose, true);
        return () => {
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('scroll', onClose, true);
        };
    }, [anchor, onClose]);

    /** Arrow keys move between the hosts. */
    const step = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    };

    return createPortal(
        <div
            ref={menu}
            className="snooze-menu handoff-host-menu"
            role="menu"
            aria-label="Hand off to"
            style={place ? {top: place.top, right: place.right} : {visibility: 'hidden'}}
            onKeyDown={step}
            onClick={(e) => e.stopPropagation()}>
            {hosts.map((host) => (
                <button
                    key={host.key}
                    type="button"
                    role="menuitem"
                    className="snooze-menu-item"
                    onClick={(e) => {
                        e.stopPropagation();
                        onPick(host);
                    }}>
                    <span>{host.label}</span>
                </button>
            ))}
        </div>,
        document.body,
    );
}

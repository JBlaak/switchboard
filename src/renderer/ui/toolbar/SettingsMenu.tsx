/**
 * The settings gear and its quick menu: Appearance, the Tasks page (only
 * while BlaakTasks is on, #249) and the way into all settings.
 *
 * Appearance and Tasks used to have a toolbar button each, always on screen
 * for things reached for now and then; the small caret on the gear is what
 * says they are in here now.
 *
 * The menu hangs below the gear in a portal on the body, and goes on a
 * choice, Escape or a click elsewhere. Picking a mode leaves it open, so the
 * repaint can be seen before it closes.
 */
import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {APPEARANCE_LABELS, APPEARANCES} from '../../../domain/settings/appearance';
import {ICONS} from '../../lib/icons';
import {openSettings} from '../settings/actions';
import {toggleTasksPage} from '../tasks-page/actions';
import {useStore} from '../use-store';
import {setAppearance} from './actions';
import type {Appearance} from '../../../domain/settings/appearance';
import type {JSX, KeyboardEvent as ReactKeyboardEvent} from 'react';

const GEAR = {__html: ICONS.gear(18)};

const ICON_FOR: Record<Appearance, {__html: string}> = {
    system: {__html: ICONS.monitor(14)},
    light: {__html: ICONS.sun(14)},
    dark: {__html: ICONS.moon(14)},
};

const ITEMS = '[role="menuitem"], [role="menuitemradio"]';

export function SettingsMenu(): JSX.Element {
    const gear = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const close = useCallback(() => setOpen(false), []);
    return (
        <>
            <button
                ref={gear}
                id="global-settings-btn"
                className={open ? 'active' : undefined}
                title="Settings"
                aria-label="Global settings"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((was) => !was)}>
                <span className="gear-icon" dangerouslySetInnerHTML={GEAR} />
                <span className="gear-caret" aria-hidden="true" />
            </button>
            {open && gear.current && <QuickMenu anchor={gear.current} onClose={close} />}
        </>
    );
}

function QuickMenu({anchor, onClose}: {anchor: HTMLElement; onClose(): void}): JSX.Element {
    const menu = useRef<HTMLDivElement>(null);
    const [place, setPlace] = useState<{top: number; right: number} | null>(null);
    const mode = useStore((s) => s.toolbar.appearance);
    const tasksEnabled = useStore((s) => s.tasks.enabled);
    const tasksOpen = useStore((s) => s.mainArea.route.kind === 'tasks');

    useLayoutEffect(() => {
        const r = anchor.getBoundingClientRect();
        setPlace({top: r.bottom + 4, right: window.innerWidth - r.right});
    }, [anchor]);

    // Once placed: a hidden menu cannot take the focus.
    const placed = place !== null;
    useEffect(() => {
        if (!placed) return;
        const checked = menu.current?.querySelector<HTMLElement>('[aria-checked="true"]');
        (checked ?? menu.current?.querySelector<HTMLElement>(ITEMS))?.focus();
    }, [placed]);

    useEffect(() => {
        const onDown = (e: MouseEvent): void => {
            const target = e.target as Node;
            if (!menu.current?.contains(target) && !anchor.contains(target)) onClose();
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            onClose();
            anchor.focus();
        };
        window.addEventListener('mousedown', onDown, true);
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', onClose);
        return () => {
            window.removeEventListener('mousedown', onDown, true);
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', onClose);
        };
    }, [anchor, onClose]);

    /** Arrow keys move between the entries, the three modes included. */
    const step = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
        const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
        if (!forward && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const items = [...(menu.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (forward ? 1 : -1) + items.length) % items.length]?.focus();
    };

    const choose = (action: () => void) => () => {
        onClose();
        action();
    };

    return createPortal(
        <div
            ref={menu}
            id="settings-quick-menu"
            role="menu"
            aria-label="Settings"
            style={place ? {top: place.top, right: place.right} : {visibility: 'hidden'}}
            onKeyDown={step}>
            <div className="sqm-label" id="sqm-appearance">
                Appearance
            </div>
            <div className="sqm-modes" role="group" aria-labelledby="sqm-appearance">
                {APPEARANCES.map((m) => (
                    <button
                        key={m}
                        type="button"
                        role="menuitemradio"
                        aria-checked={m === mode}
                        className={m === mode ? 'selected' : undefined}
                        onClick={() => setAppearance(m)}>
                        <span className="sqm-icon" dangerouslySetInnerHTML={ICON_FOR[m]} />
                        {APPEARANCE_LABELS[m]}
                    </button>
                ))}
            </div>
            <div className="sqm-divider" role="separator" />
            {tasksEnabled && (
                <button
                    type="button"
                    role="menuitem"
                    aria-current={tasksOpen ? 'page' : undefined}
                    className={`sqm-item${tasksOpen ? ' active' : ''}`}
                    onClick={choose(toggleTasksPage)}>
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true">
                        <path d="m4 7 2 2 3.5-4M4 16l2 2 3.5-4M13 8h7M13 17h7" />
                    </svg>
                    <span>Tasks</span>
                    <small>⌘T</small>
                </button>
            )}
            <button type="button" role="menuitem" className="sqm-item" onClick={choose(() => void openSettings())}>
                <span className="sqm-icon" dangerouslySetInnerHTML={{__html: ICONS.gear(16)}} />
                <span>All settings…</span>
            </button>
        </div>,
        document.body,
    );
}

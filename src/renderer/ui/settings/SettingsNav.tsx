/**
 * The settings panel's pages and the list that picks one: tabs down the
 * left, one page beside them.
 *
 * A page that is not chosen is hidden, not unmounted: the form's controls are
 * uncontrolled and read once on Save, so what was typed on another page has
 * to still be there when it is.
 */
import {useRef} from 'react';
import {SETTINGS_CATEGORIES, type SettingsCategory} from '../../state/settings-categories';
import {chooseSettingsCategory} from './actions';
import type {JSX, KeyboardEvent, ReactNode} from 'react';

function tabId(category: SettingsCategory): string {
    return `settings-tab-${category}`;
}

function pageId(category: SettingsCategory): string {
    return `settings-page-${category}`;
}

/** ↑/↓ (and Home/End) step through the list, the way a vertical tab list does. */
function steppedTo(key: string, from: SettingsCategory): SettingsCategory | null {
    const ids = SETTINGS_CATEGORIES.map((c) => c.id);
    const at = ids.indexOf(from);
    if (key === 'ArrowDown') return ids[(at + 1) % ids.length];
    if (key === 'ArrowUp') return ids[(at - 1 + ids.length) % ids.length];
    if (key === 'Home') return ids[0];
    if (key === 'End') return ids[ids.length - 1];
    return null;
}

export function SettingsNav({category}: {category: SettingsCategory}): JSX.Element {
    const list = useRef<HTMLDivElement>(null);

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
        const next = steppedTo(event.key, category);
        if (!next) return;
        event.preventDefault();
        chooseSettingsCategory(next);
        list.current?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus();
    }

    return (
        <div
            className="settings-nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings pages"
            ref={list}
            onKeyDown={onKeyDown}>
            {SETTINGS_CATEGORIES.map(({id, label, hint}) => {
                const selected = id === category;
                return (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        id={tabId(id)}
                        aria-selected={selected}
                        aria-controls={pageId(id)}
                        aria-labelledby={`${tabId(id)}-label`}
                        aria-describedby={`${tabId(id)}-hint`}
                        tabIndex={selected ? 0 : -1}
                        className={selected ? 'settings-nav-item selected' : 'settings-nav-item'}
                        onClick={() => chooseSettingsCategory(id)}>
                        <span className="settings-nav-label" id={`${tabId(id)}-label`}>
                            {label}
                        </span>
                        <span className="settings-nav-hint" id={`${tabId(id)}-hint`}>
                            {hint}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}

/** One page of the panel; mounted always, shown only while chosen. */
export function SettingsPage({
    id,
    shown,
    children,
}: {
    id: SettingsCategory;
    shown: SettingsCategory;
    children: ReactNode;
}): JSX.Element {
    return (
        <div
            className="settings-page"
            role="tabpanel"
            id={pageId(id)}
            aria-labelledby={tabId(id)}
            hidden={id !== shown}>
            {children}
        </div>
    );
}

/**
 * The switch at the top of the list area: Sessions | Pull requests.
 *
 * Two real buttons, each pressed while its page is the one shown. The pill
 * behind them is not React's: it rides `--sidebar-page-progress`, which the
 * swipe writes on `#sidebar` every wheel event (`install-sidebar-pages`), so
 * it slides with the fingers and settles with the pages.
 */
import {useStore} from '../use-store';
import {showSidebarPage} from './actions';
import type {JSX} from 'react';
import type {SidebarPage} from '../../state/sidebar-page-slice';

const OPTIONS: readonly {page: SidebarPage; label: string}[] = [
    {page: 'sessions', label: 'Sessions'},
    {page: 'pullRequests', label: 'Pull requests'},
];

export function SidebarPageSwitch(): JSX.Element {
    const shown = useStore((s) => s.sidebarPage.page);
    return (
        <div className="page-switch" role="group" aria-label="Sidebar page">
            <span className="page-switch-pill" aria-hidden="true" />
            {OPTIONS.map(({page, label}) => (
                <button
                    key={page}
                    type="button"
                    className="page-switch-option"
                    data-testid={`sidebar-page-${page}`}
                    aria-pressed={shown === page}
                    title={`${label}: ⌘P or a two-finger swipe flips between the pages`}
                    onClick={() => showSidebarPage(page)}>
                    {label}
                </button>
            ))}
        </div>
    );
}

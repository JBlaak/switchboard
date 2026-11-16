/**
 * The Not landed page (View all): what `#merge-manager-page` shows while the
 * Merge manager's view is `notLanded`. Every one of your open PRs that is not
 * in a lane, newest first, in one card with the section's rows and side
 * view, and a chip per project to keep one project's.
 *
 * Its keys, while it has the focus and never in a field: J/K, L, ⏎ and O as
 * on a Not landed row (`notLandedKeyAction`); Esc closes the side view, then
 * goes back to the lanes (the Merge manager stays open).
 */
import {useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent} from 'react';
import {getState} from '../../state/app-store';
import {useStore} from '../use-store';
import {SceneFigure} from '../bug-manager/ManagerFigure';
import {Freshness} from '../shared/Freshness';
import {mergeFigureOf, type MergeFigure} from '../../../domain/merge-manager/figure';
import {
    inRepository,
    notLanded,
    notLandedKey,
    notLandedRepositories,
    repositoryShortName,
} from '../../../domain/merge-manager/not-landed';
import {NotLandedRow} from './NotLandedRow';
import {NotLandedDetail} from './NotLandedDetail';
import {findSelection, notLandedPageSubline, visibleRows} from './not-landed-rows';
import {notLandedKeyAction} from './page-keys';
import {closeMergeDetail, sessionOf, stepMergeRow, toggleMergeRow} from './page-actions';
import {carryOutNotLandedKey, closeNotLandedPage, filterNotLanded} from './not-landed-actions';

/** The letters the page's keys use; its own even where a row does not offer them. */
const PAGE_LETTERS = new Set(['j', 'k', 'l', 'o', 't', 'n', 'u']);

function sameFigure(a: MergeFigure, b: MergeFigure): boolean {
    return a.pose === b.pose && a.count === b.count;
}

export function NotLandedPage(): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const merge = useStore((state) => state.mergeManager.state);
    const open = useStore((state) => state.mergeManager.notLanded);
    const openAt = useStore((state) => state.mergeManager.notLandedFetchedAt);
    const openFailed = useStore((state) => state.mergeManager.notLandedFailed);
    const page = useStore((state) => state.mergeManager.page);
    const busy = useStore((state) => state.mergeManager.busy);
    const figure = useStore((state) => mergeFigureOf(state.mergeManager.state), sameFigure);
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const all = notLanded(open ?? [], merge);
    const projects = notLandedRepositories(all);
    const rows = inRepository(all, page.repository);
    // A row landed from here leaves the page: its side view goes with it.
    const selected = page.detailOpen ? findSelection({lanes: [], notLanded: rows}, page.selected) : null;
    const selectedPr = selected?.kind === 'notLanded' ? selected.pr : null;
    const chip = page.repository?.toLowerCase() ?? null;

    // Into the page as it opens, so its keys reach it without a click.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, []);

    // The selected row stays in view.
    useEffect(() => {
        if (!selected) return;
        root.current
            ?.querySelector(`[data-merge-key="${CSS.escape(selected.key)}"]`)
            ?.scrollIntoView({block: 'nearest'});
    }, [selected?.key]);

    const focusRows = (): void => root.current?.focus({preventScroll: true});

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (getState().mergeManager.page.detailOpen) {
                closeMergeDetail();
                focusRows();
            } else closeNotLandedPage();
            return;
        }
        if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
        // A focused button takes its own ⏎.
        if (e.key === 'Enter' && target !== root.current) return;
        if (e.shiftKey) return;
        if (PAGE_LETTERS.has(e.key.toLowerCase())) {
            e.preventDefault();
            e.stopPropagation();
        }
        const state = getState().mergeManager;
        const current = state.page.detailOpen ? findSelection(visibleRows(state), state.page.selected) : null;
        if (current?.kind !== 'notLanded') {
            // No row open yet: J/K open one.
            if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'ArrowUp') {
                e.preventDefault();
                stepMergeRow(e.key === 'j' || e.key === 'ArrowDown' ? 1 : -1);
            }
            return;
        }
        const action = notLandedKeyAction(e.key, current.pr, sessionOf(current.pr) !== null);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        carryOutNotLandedKey(action, root.current);
    };

    const onSelect = (key: string): void => {
        toggleMergeRow(key);
        focusRows();
    };

    return (
        <div
            ref={root}
            className="sw-page mm-page mm-nl-page"
            tabIndex={-1}
            role="region"
            aria-label="Not landed"
            onKeyDown={onKeyDown}>
            <header className="sw-header pp-header">
                <div className="sw-header-row">
                    <button
                        type="button"
                        className="sw-btn sw-back"
                        onClick={closeNotLandedPage}
                        aria-label="Back to the Merge manager (Esc)">
                        <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true">
                            <path d="M15 18l-6-6 6-6" />
                        </svg>
                        Merge manager <kbd className="sw-kbd">esc</kbd>
                    </button>
                    <SceneFigure scene={{kind: 'merge', state: figure.pose, count: figure.count, label: ''}} />
                    <div className="sw-heading">
                        <span className="mm-nl-crumb">Merge manager ›</span>
                        <h1 className="sw-title pp-title">Not landed</h1>
                        <div className="sw-subline pp-subline">
                            <span>{notLandedPageSubline(all, projects.length)}</span>
                            {/* The open PRs search is never held back for GitHub's budget. */}
                            <Freshness fetchedAt={openAt} failed={openFailed} showHeld={false} />
                        </div>
                    </div>
                </div>
            </header>

            {page.notice && (
                <div className="tk-status" role="status">
                    {page.notice}
                </div>
            )}

            <div className="im-filters mm-nl-chips" role="group" aria-label="Projects">
                <button
                    type="button"
                    aria-pressed={chip === null}
                    className={'im-filter' + (chip === null ? ' is-on' : '')}
                    onClick={() => filterNotLanded(null)}>
                    All <span className="mm-nl-count">{all.length}</span>
                </button>
                {projects.map(({repository, count}) => {
                    const on = chip === repository.toLowerCase();
                    return (
                        <button
                            key={repository}
                            type="button"
                            aria-pressed={on}
                            title={repository}
                            className={'im-filter' + (on ? ' is-on' : '')}
                            onClick={() => filterNotLanded(repository)}>
                            {repositoryShortName(repository)} <span className="mm-nl-count">{count}</span>
                        </button>
                    );
                })}
            </div>

            <div className={'mm-body' + (selectedPr ? ' has-detail' : '')}>
                <div className="mm-list" role="listbox" aria-label="Not landed">
                    {rows.length > 0 ? (
                        <section className="mm-card mm-lanecard mm-nl" role="group" aria-label="Not landed">
                            {rows.map((pr) => (
                                <NotLandedRow
                                    key={notLandedKey(pr)}
                                    pr={pr}
                                    now={now}
                                    selected={selected?.key === notLandedKey(pr)}
                                    busy={busy[notLandedKey(pr)] === 'land'}
                                    onSelect={onSelect}
                                />
                            ))}
                        </section>
                    ) : (
                        <p className="mm-nl-none">
                            {open === null
                                ? 'Reading your open pull requests…'
                                : 'Every open pull request of yours here is in a lane.'}
                        </p>
                    )}
                </div>
                {selectedPr && <NotLandedDetail pr={selectedPr} busy={busy[notLandedKey(selectedPr)] === 'land'} />}
            </div>

            <footer className="tk-keys" aria-label="Keys">
                <span>
                    <kbd className="sw-kbd">J</kbd>/<kbd className="sw-kbd">K</kbd> next, previous
                </span>
                <span>
                    <kbd className="sw-kbd">L</kbd> land it
                </span>
                <span>
                    <kbd className="sw-kbd">↵</kbd> open session
                </span>
                <span>
                    <kbd className="sw-kbd">O</kbd> open on GitHub
                </span>
                <span>
                    <kbd className="sw-kbd">esc</kbd> back
                </span>
            </footer>
        </div>
    );
}

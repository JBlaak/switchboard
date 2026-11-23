/**
 * The sidebar's second page: your open pull requests, landed or not, under a
 * header per repository (its coloured mark and name), each row a status dot
 * in its group's colour, the PR's title and "#523 · Ready to land" under it
 * (`pr-list-rows`). The row whose PR the main area shows is lit like the
 * session on screen is in the session list.
 *
 * A click or ⏎ opens the PR's detail page; Land it (on the rows the Merge
 * manager lets land) hands it over with the rocket from the row. While the
 * list has the focus, ↑/↓ or J/K move its cursor, L lands, O opens GitHub
 * and Esc gives the keys back (`actions`).
 *
 * Rendered into `#sidebar-prs`, which the sidebar's page switch shows and
 * hides; it is the scroll container, this list the focus.
 */
import {useMemo, type JSX, type KeyboardEvent} from 'react';
import {useStore} from '../use-store';
import {shallowEqual} from '../../state/store';
import {landFailure} from '../../state/merge-manager-slice';
import {Freshness} from '../shared/Freshness';
import {RepoMark} from '../shared/RepoMark';
import {LandItControl} from '../merge-manager/LandIt';
import {
    listState,
    onScreenKey,
    pullRequestList,
    pullRequestListKey,
    pullRequestOnScreen,
    type PullRequestListRow,
} from './pr-list-rows';
import {
    PR_LIST_ID,
    cursorRow,
    landCursorRow,
    landPullRequestRow,
    leavePullRequestList,
    openPullRequestRow,
    openPullRequestRowOnGitHub,
    setPullRequestCursor,
    stepPullRequestCursor,
} from './actions';

const LAND_IT = {kind: 'land'} as const;

export function PullRequestList(): JSX.Element {
    const merge = useStore((state) => state.mergeManager.state);
    const open = useStore((state) => state.mergeManager.notLanded);
    const failed = useStore((state) => state.mergeManager.notLandedFailed);
    const cursor = useStore((state) => state.sidebarPrs.cursor);
    const onScreen = useStore(
        (state) => pullRequestOnScreen(state.mainArea.route, state.sessionWork.page),
        (a, b) => a === b || (a !== null && b !== null && shallowEqual(a, b)),
    );
    const repos = useMemo(() => pullRequestList(merge, open), [merge, open]);
    const active = onScreenKey(repos, onScreen);
    const rows = repos.reduce((sum, repo) => sum + repo.rows.length, 0);
    const shows = listState(rows, {hasRead: open !== null, failed});

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        // A focused button takes its own keys; the list's are heard on the list.
        if (e.target !== e.currentTarget) return;
        const key = pullRequestListKey(e);
        if (!key) return;
        e.preventDefault();
        e.stopPropagation();
        switch (key) {
            case 'down':
            case 'up':
                stepPullRequestCursor(key === 'down' ? 1 : -1);
                return;
            case 'open': {
                const row = cursorRow();
                if (row) void openPullRequestRow(row);
                return;
            }
            case 'land':
                landCursorRow();
                return;
            case 'github': {
                const row = cursorRow();
                if (row) openPullRequestRowOnGitHub(row);
                return;
            }
            case 'leave':
                leavePullRequestList();
                return;
        }
    };

    return (
        <div
            id={PR_LIST_ID}
            className="pr-list"
            data-testid="pr-list"
            tabIndex={-1}
            role="listbox"
            aria-label="Pull requests"
            onKeyDown={onKeyDown}
            onBlur={(e) => {
                // Its own Land it keeps the cursor; anywhere else ends it.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPullRequestCursor(null);
            }}>
            <div className="pr-list-fresh">
                <ListFreshness />
            </div>
            {shows === 'loading' && <p className="pr-list-note">Reading your pull requests…</p>}
            {shows === 'empty' && <p className="pr-list-note">No open pull requests</p>}
            {shows === 'failed' && (
                <p className="pr-list-note is-failed">Could not read your pull requests from GitHub.</p>
            )}
            {repos.map((repo) => (
                <section key={repo.repository} className="pr-repo" role="group" aria-label={repo.name}>
                    <div className="pr-repo-head" title={repo.repository}>
                        <span className="pr-repo-mark">
                            <RepoMark name={repo.repository} />
                        </span>
                        <span className="pr-repo-name">{repo.name}</span>
                        <span className="pr-repo-count">{repo.rows.length}</span>
                    </div>
                    {repo.rows.map((row) => (
                        <PullRequestItem
                            key={row.key}
                            row={row}
                            active={row.key === active}
                            cursor={row.key === cursor}
                        />
                    ))}
                </section>
            ))}
        </div>
    );
}

/** "Updated 3m ago · open PRs 1m ago", a spinner while the list reads, "Couldn't refresh" after a failed read. */
function ListFreshness(): JSX.Element | null {
    const lanes = useStore((state) => state.mergeManager.state.freshness);
    const openAt = useStore((state) => state.mergeManager.notLandedFetchedAt);
    const openFailed = useStore((state) => state.mergeManager.notLandedFailed);
    const reading = useStore((state) => state.sidebarPrs.reading);
    return (
        <Freshness
            fetchedAt={lanes?.fetchedAt ?? openAt}
            refreshing={reading || lanes?.refreshing}
            failed={lanes?.failed || openFailed}
            parts={lanes?.fetchedAt ? [{label: 'open PRs', at: openAt}] : []}
            showHeld={false}
        />
    );
}

function PullRequestItem({
    row,
    active,
    cursor,
}: {
    row: PullRequestListRow;
    /** Its PR is on screen. */
    active: boolean;
    cursor: boolean;
}): JSX.Element {
    const busy = useStore((state) => state.mergeManager.busy[row.key] ?? null);
    const failure = useStore((state) => landFailure(state.mergeManager, row.repository, row.number));
    const classes = [
        'pr-row',
        'is-tone-' + row.tone,
        active ? 'active' : '',
        cursor ? 'kbd-cursor' : '',
        row.draft ? 'is-draft' : '',
        row.land === 'ready' ? 'is-ready' : '',
        busy ? 'is-landing' : '',
    ].filter(Boolean);
    return (
        <div
            role="option"
            aria-selected={active}
            className={classes.join(' ')}
            data-pr-key={row.key}
            data-group={row.group}
            title={row.hint}
            onClick={() => void openPullRequestRow(row)}>
            <span className="pr-row-gutter" aria-hidden="true">
                <i className="pr-row-dot" />
            </span>
            <span className="pr-row-text">
                <span className="pr-row-title">{row.title}</span>
                <span className="pr-row-sub">{row.subline}</span>
            </span>
            {row.land && (
                <span className="pr-row-land">
                    <LandItControl
                        offer={LAND_IT}
                        busy={busy}
                        failure={failure}
                        size="sm"
                        onLand={(from) => landPullRequestRow(row, from)}
                        onUnland={() => {}}
                    />
                </span>
            )}
        </div>
    );
}

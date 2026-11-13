/**
 * The Issue manager page (#415): what the main area shows while its route is
 * `issueManager`. The loose issues of the repositories with Watch issues on,
 * unassigned or yours: tabs (Inbox, In progress, Done, Snoozed, Backlog),
 * tiles over the inbox that count and filter it (Unread, New, New comments,
 * In progress), the list grouped by repository, and the selected issue's
 * detail beside it.
 *
 * Its keys, while it has the focus and never in a field, are `page-keys`;
 * Esc puts away what is open (a menu, a question), then closes the page.
 *
 * Rendered into `#issue-manager-page`, which `ui/main-area/install-main-area`
 * shows and hides with the route.
 */
import {useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent} from 'react';
import {getState} from '../../state/app-store';
import {useStore} from '../use-store';
import {formatDate} from '../../lib/format';
import {selectedItem, visibleGroups, type IssueManagerState} from '../../state/issue-manager-slice';
import {INBOX_TABS, INBOX_TAB_LABELS, tabCounts} from '../../../domain/inbox/tabs';
import {issueChip, issueTiles, shownLabels, type IssueFilter} from '../../../domain/inbox/issue-manager';
import type {InboxItem} from '../../../domain/inbox/model';
import {IssueDetail, StagePill} from './IssueDetail';
import {issueKeyAction} from './page-keys';
import {
    backlogIssue,
    chooseFilter,
    chooseTab,
    closeIssueManager,
    closeSnooze,
    commentFromNotes,
    dismissStopWork,
    openIssueSession,
    openOnGitHub,
    openSnooze,
    selectIssue,
    startIssue,
    stepSelection,
} from './actions';

export function IssueManagerPage(): JSX.Element | null {
    const open = useStore((state) => state.mainArea.route.kind === 'issueManager');
    return open ? <IssueManagerView /> : null;
}

function IssueManagerView(): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const page = useStore((state) => state.issueManager);
    const groups = visibleGroups(page);
    const selected = selectedItem(page);
    const items = page.items ?? [];
    const counts = tabCounts(items);
    const tiles = issueTiles(items);
    const repositories = new Set(items.map((item) => item.source)).size;

    // Into the page as it opens, so its keys reach it without a click.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, []);

    // The selected row stays in view.
    useEffect(() => {
        if (!page.selected) return;
        root.current
            ?.querySelector(`[data-issue-key="${CSS.escape(page.selected)}"]`)
            ?.scrollIntoView({block: 'nearest'});
    }, [page.selected]);

    const focusNotes = (): void => {
        root.current?.querySelector<HTMLTextAreaElement>('.im-notes')?.focus();
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target as HTMLElement;
        const state = getState().issueManager;
        if (e.key === 'Escape') {
            e.preventDefault();
            if (target.matches('input, textarea')) root.current?.focus({preventScroll: true});
            else if (state.snooze) {
                closeSnooze();
                root.current?.focus({preventScroll: true});
            } else if (state.stop) dismissStopWork();
            else closeIssueManager();
            return;
        }
        if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
        // A focused button or menu item takes its own ⏎ and arrows.
        if (target.closest('[role="menu"]') || (e.key === 'Enter' && target !== root.current)) return;
        // ⇧M is the one shifted key.
        if (e.shiftKey && e.key !== 'M') return;
        const action = issueKeyAction(e.key, selectedItem(state));
        if (!action) return;
        e.preventDefault();
        switch (action.kind) {
            case 'step':
                stepSelection(action.step);
                break;
            case 'notes':
                focusNotes();
                break;
            case 'comment':
                void commentFromNotes(action.item.key, false);
                break;
            case 'postNow':
                void commentFromNotes(action.item.key, true);
                break;
            case 'start':
                void startIssue(action.item.key);
                break;
            case 'openSession':
                void openIssueSession(action.item);
                break;
            case 'snooze':
                void openSnooze(action.item.key);
                break;
            case 'backlog':
                void backlogIssue(action.item.key);
                break;
            case 'github':
                openOnGitHub(action.item);
                break;
        }
    };

    return (
        <div
            ref={root}
            className="sw-page issue-manager-page"
            tabIndex={-1}
            role="region"
            aria-label="Issue manager"
            onKeyDown={onKeyDown}>
            <header className="sw-header pp-header">
                <div className="sw-header-row">
                    <button
                        type="button"
                        className="sw-btn sw-back"
                        onClick={closeIssueManager}
                        aria-label="Close the Issue manager (Esc)">
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
                            <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                        Close <kbd className="sw-kbd">esc</kbd>
                    </button>
                    <div className="sw-heading">
                        <h1 className="sw-title pp-title">Issue manager</h1>
                        <div className="sw-subline pp-subline">
                            <span>
                                {repositories === 1 ? '1 watched repo' : `${repositories} watched repos`} · loose,
                                unassigned or yours
                            </span>
                        </div>
                    </div>
                </div>
            </header>

            <nav className="tk-tabs" role="tablist" aria-label="Issues">
                {INBOX_TABS.map((tab) => (
                    <button
                        type="button"
                        key={tab}
                        role="tab"
                        aria-selected={page.tab === tab}
                        className={'tk-tab' + (page.tab === tab ? ' is-on' : '')}
                        onClick={() => {
                            chooseTab(tab);
                            root.current?.focus({preventScroll: true});
                        }}>
                        {INBOX_TAB_LABELS[tab]}
                        {counts[tab] > 0 && <span className="im-tab-count">{counts[tab]}</span>}
                    </button>
                ))}
            </nav>

            <div className="im-tiles" role="group" aria-label="Summary">
                <Tile filter="unread" page={page} n={tiles.unread} label="Unread" hint="to go through" />
                <Tile filter="new" page={page} n={tiles.new} label="New" hint="not seen yet" tone="cool" />
                <Tile
                    filter="comments"
                    page={page}
                    n={tiles.comments}
                    label="New comments"
                    hint="since you looked"
                    tone="hot"
                />
                <button
                    type="button"
                    className={'im-tile is-lav' + (page.tab === 'inProgress' ? ' is-on' : '')}
                    onClick={() => chooseTab('inProgress')}>
                    <span className="im-tile-n">{tiles.inProgress}</span>
                    <span className="im-tile-l">In progress</span>
                    <span className="im-tile-hint">being worked on</span>
                </button>
            </div>

            {page.notice && (
                <div className="tk-status" role="status">
                    {page.notice}
                </div>
            )}

            <div className={'im-body' + (selected ? ' has-detail' : '')}>
                <div className="im-list" role="listbox" aria-label="Issues">
                    <EmptyLine page={page} count={groups.length} />
                    {groups.map((group) => (
                        <div key={group.repository} role="group" aria-label={group.repository}>
                            <div className="im-group">{group.repository}</div>
                            {group.items.map((item) => (
                                <IssueRow
                                    key={item.key}
                                    item={item}
                                    selected={page.selected === item.key}
                                    starting={page.start?.key === item.key && page.start.phase === 'starting'}
                                    onClick={() => {
                                        selectIssue(item.key);
                                        root.current?.focus({preventScroll: true});
                                    }}
                                />
                            ))}
                        </div>
                    ))}
                </div>
                {selected && <IssueDetail item={selected} page={page} onFocusRows={() => root.current?.focus()} />}
            </div>

            <footer className="tk-keys" aria-label="Keys">
                <span>
                    <kbd className="sw-kbd">J</kbd>/<kbd className="sw-kbd">K</kbd> next, previous
                </span>
                <span>
                    <kbd className="sw-kbd">C</kbd> notes
                </span>
                <span>
                    <kbd className="sw-kbd">M</kbd> comment
                </span>
                <span>
                    <kbd className="sw-kbd">⇧M</kbd> polish and post now
                </span>
                <span>
                    <kbd className="sw-kbd">↵</kbd> start and claim
                </span>
                <span>
                    <kbd className="sw-kbd">S</kbd> snooze
                </span>
                <span>
                    <kbd className="sw-kbd">B</kbd> backlog
                </span>
                <span>
                    <kbd className="sw-kbd">O</kbd> open on GitHub
                </span>
            </footer>
        </div>
    );
}

function Tile({
    filter,
    page,
    n,
    label,
    hint,
    tone,
}: {
    filter: IssueFilter;
    page: IssueManagerState;
    n: number;
    label: string;
    hint: string;
    tone?: 'cool' | 'hot';
}): JSX.Element {
    const on = page.tab === 'inbox' && page.filter === filter;
    return (
        <button
            type="button"
            aria-pressed={on}
            className={'im-tile' + (tone ? ' is-' + tone : '') + (on ? ' is-on' : '')}
            onClick={() => chooseFilter(filter)}>
            <span className="im-tile-n">{n}</span>
            <span className="im-tile-l">{label}</span>
            <span className="im-tile-hint">{hint}</span>
        </button>
    );
}

const CHIP_LABELS = {new: 'New', comments: 'Comment', changed: 'Changed'} as const;

function IssueRow({
    item,
    selected,
    starting,
    onClick,
}: {
    item: InboxItem;
    selected: boolean;
    starting: boolean;
    onClick: () => void;
}): JSX.Element | null {
    const now = useStore((state) => state.sessionList.now) || Date.now();
    if (item.facts.kind !== 'issue') return null;
    const facts = item.facts;
    const chip = issueChip(item);
    const {shown, more} = shownLabels(facts.labels);
    const mine = facts.assignees.length > 0;
    return (
        <div
            role="option"
            aria-selected={selected}
            data-issue-key={item.key}
            className={'im-row' + (selected ? ' is-selected' : '') + (chip ? '' : ' is-read')}
            onClick={onClick}>
            <span className="im-dot" aria-label={chip ? 'Unread' : undefined} />
            <span className="im-chip-slot">
                {chip && <span className={'im-chip is-' + chip}>{CHIP_LABELS[chip]}</span>}
                {item.state.kind === 'inProgress' && <StagePill stage={item.state.stage} />}
                {item.state.kind === 'done' && <span className="im-chip is-done">Done</span>}
            </span>
            <span className="im-row-text">
                <span className="im-row-title">
                    <span className="im-row-name">
                        #{facts.number} {facts.title}
                    </span>
                    {shown.map((label) => (
                        <span key={label.name} className="im-label">
                            {label.name}
                        </span>
                    ))}
                    {more > 0 && <span className="im-label">+{more}</span>}
                </span>
                <span className="im-row-meta">
                    {facts.author ?? 'ghost'} · {formatDate(new Date(facts.createdAt), now)} ·{' '}
                    {mine ? 'assigned to you' : 'unassigned'}
                    {item.state.kind === 'done' && item.work?.pullRequest
                        ? ` · Closed by #${item.work.pullRequest}`
                        : ''}
                </span>
            </span>
            <span className="im-row-nums">
                {starting ? (
                    'Starting…'
                ) : (
                    <>
                        <b>{facts.comments}</b> {facts.comments === 1 ? 'comment' : 'comments'}
                    </>
                )}
            </span>
        </div>
    );
}

function EmptyLine({page, count}: {page: IssueManagerState; count: number}): JSX.Element | null {
    if (count > 0) return null;
    if (page.items === null) return <div className="pp-quiet">Loading…</div>;
    if (page.items.length === 0)
        return (
            <div className="pp-quiet">
                No issues yet. Turn on Watch issues on a project’s page, and its loose issues come here.
            </div>
        );
    if (page.tab === 'inbox' && page.filter) return <div className="pp-quiet">Nothing matches this tile.</div>;
    return <div className="pp-quiet">{page.tab === 'inbox' ? 'Inbox zero.' : 'Nothing here.'}</div>;
}

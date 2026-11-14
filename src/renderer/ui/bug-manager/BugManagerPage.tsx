/**
 * The Bug manager page (#414, for #409): what the main area shows while its
 * route is `bugs`, opened with ⌘B.
 *
 * The Bug manager's head and when it last checked; the tabs (Inbox, In
 * progress, Done, Snoozed, Backlog) with their counts; the filters over
 * the inbox; the bugs grouped by local project, each row with its signal,
 * severity and triage on a top line, its title over two lines, where it
 * happens and when it was first and last seen, a 7-day sparkline and
 * today's events against its average; and the row under the cursor in
 * detail beside them, with its triage, Fix, Snooze, Backlog and Triage, or,
 * while a Fix works on it, its stage, PR and session.
 *
 * Its keys, while it has the focus and never in an input, are `page-keys`;
 * Esc closes the snooze menu, then the page.
 *
 * Rendered into `#bug-page`, which `ui/main-area/install-main-area` shows and
 * hides with the route.
 */
import {useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent} from 'react';
import {getState} from '../../state/app-store';
import {useStore} from '../use-store';
import {
    bugCursorRow,
    bugGroups,
    inProgressWantsYou,
    sourceName,
    type BugFilter,
    type BugPageState,
} from '../../state/bug-page-slice';
import {inProgressPill, landedForItem, needsYouInProgress} from '../../../domain/merge-manager/stage-words';
import {INBOX_TABS, INBOX_TAB_LABELS, tabCounts} from '../../../domain/inbox/tabs';
import {seenAgainLine} from '../../../domain/inbox/seen-again';
import {fixBranch} from '../../../domain/inbox/fix';
import type {BugFacts, BugTriage, InboxItem, InboxStage} from '../../../domain/inbox/model';
import type {BugsnagProjectSetting} from '../../../domain/bugsnag/connection';
import {bugKeyAction} from './page-keys';
import {ManagerFigure} from './ManagerFigure';
import {Sparkline} from './Sparkline';
import {
    TRIAGE_SUGGESTION_LABEL,
    compactCount,
    groupedCount,
    primarySortAction,
    relativeAge,
    timesItsAverage,
    triagePhase,
    type BugSortAction,
} from './bug-row-words';
import {
    backlogBug,
    chooseBugFilter,
    chooseBugTab,
    closeBugAgain,
    closeBugPage,
    closeBugSnooze,
    fixBug,
    loadBugDetail,
    loadBugTrends,
    moveBugCursor,
    openBugInBugsnag,
    openBugSnooze,
    openFixSession,
    openInBrowser,
    openTriageSession,
    snoozeBug,
    stepBugCursor,
    stopWorkingOnBug,
    treatBugAsRegressed,
    triageBug,
} from './page-actions';

export function BugManagerPage(): JSX.Element | null {
    const open = useStore((state) => state.mainArea.route.kind === 'bugs');
    return open ? <BugManagerView /> : null;
}

function BugManagerView(): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const page = useStore((state) => state.bugPage);
    const merge = useStore((state) => state.mergeManager.state);
    const counts = useStore((state) => state.inbox.summary.bug);
    const groups = bugGroups(page);
    const under = bugCursorRow(page);

    // Into the page as it opens, so its keys reach it without a click.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, []);

    // The row under the cursor stays in view, and its detail is read.
    useEffect(() => {
        if (!under) return;
        void loadBugDetail(under.key);
        root.current?.querySelector(`[data-bug-key="${CSS.escape(under.key)}"]`)?.scrollIntoView({block: 'nearest'});
    }, [under?.key]);

    // The rows' sparklines, one after another.
    const keys = groups.flatMap((group) => group.rows.map((row) => row.key)).join('\n');
    useEffect(() => {
        if (keys) void loadBugTrends(keys.split('\n'));
    }, [keys]);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
        const state = getState().bugPage;
        if (e.key === 'Escape') {
            e.preventDefault();
            if (state.snooze) closeBugSnooze();
            else closeBugPage();
            return;
        }
        // Enter on a focused button presses it.
        if (e.key === 'Enter' && (e.target as HTMLElement).matches('button, a')) return;
        const action = bugKeyAction(e.key, bugCursorRow(state));
        if (!action) return;
        e.preventDefault();
        switch (action.kind) {
            case 'cursor':
                stepBugCursor(action.step);
                break;
            case 'fix':
                if (fixDisabled(state.projects, rowOf(state, action.key))) return;
                void fixBug(action.key);
                break;
            case 'openSession':
                void openFixSession(action.item);
                break;
            case 'snooze':
                void openBugSnooze(action.key);
                break;
            case 'backlog':
                void backlogBug(action.key);
                break;
            case 'bugsnag':
                void openBugInBugsnag(action.key);
                break;
            case 'triage':
                if (fixDisabled(state.projects, rowOf(state, action.key))) return;
                void triageBug(action.key);
                break;
        }
    };

    const tabs = tabCounts(page.items);
    const sources = new Set(page.items.map((item) => item.source)).size;

    return (
        <div
            ref={root}
            className="sw-page bm-page"
            tabIndex={-1}
            role="region"
            aria-label="Bug manager"
            onKeyDown={onKeyDown}>
            <header className="sw-header pp-header bm-header">
                <div className="sw-header-row">
                    <button
                        type="button"
                        className="sw-btn sw-back"
                        onClick={closeBugPage}
                        aria-label="Close the Bug manager (Esc)">
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
                    <ManagerFigure kind="bug" counts={counts} />
                    <div className="sw-heading">
                        <h1 className="sw-title pp-title">Bug manager</h1>
                        <div className="sw-subline pp-subline">
                            <span>
                                {sources} Bugsnag {sources === 1 ? 'project' : 'projects'}
                            </span>
                            <CheckedAgo at={page.polledAt} />
                        </div>
                    </div>
                </div>
            </header>

            <nav className="tk-tabs bm-tabs" role="tablist" aria-label="Views">
                {INBOX_TABS.map((tab) => (
                    <button
                        type="button"
                        key={tab}
                        role="tab"
                        aria-selected={page.tab === tab}
                        className={'tk-tab' + (page.tab === tab ? ' is-on' : '')}
                        onClick={() => {
                            chooseBugTab(tab);
                            root.current?.focus({preventScroll: true});
                        }}>
                        {INBOX_TAB_LABELS[tab]} <span className="bm-tab-count">{tabs[tab]}</span>
                        {tab === 'inProgress' &&
                            (inProgressWantsYou(page.items) || needsYouInProgress(page.items, merge)) && (
                                <i className="bm-tab-dot" aria-label="needs you" />
                            )}
                    </button>
                ))}
            </nav>

            <div className="im-filters bm-filters" role="group" aria-label="Filters">
                <Filter filter="unread" label="Unread" page={page} />
                <Filter filter="trending" label="Trending" page={page} tone="hot" />
                <Filter filter="regressed" label="Regressed" page={page} tone="red" />
                <Filter filter="new" label="New" page={page} tone="cool" />
            </div>

            {page.notice && (
                <div className="bm-notice" role="status">
                    {page.notice}
                </div>
            )}

            <div className="bm-split">
                <div className="bm-list" role="listbox" aria-label="Bugs">
                    {groups.length === 0 && (
                        <p className="pp-quiet bm-empty">
                            {page.loaded ? emptyLine(page) : 'Reading the Bug manager…'}
                        </p>
                    )}
                    {groups.map((group) => (
                        <section key={group.projectPath ?? ''} className="bm-group" aria-label={group.title}>
                            <h2 className={'bm-group-title' + (group.projectPath ? '' : ' is-unlinked')}>
                                {group.title}
                                <span className="bm-group-from">
                                    from{' '}
                                    {group.sources.map((source, i) => (
                                        <span key={source}>
                                            {i > 0 && ' + '}
                                            <b>{source}</b>
                                        </span>
                                    ))}
                                </span>
                            </h2>
                            {group.rows.map((row) => (
                                <BugRow key={row.key} item={row} page={page} selected={row.key === under?.key} />
                            ))}
                        </section>
                    ))}
                </div>
                <div className="bm-detail">{under && <BugDetailPane item={under} page={page} />}</div>
            </div>

            <footer className="tk-keys bm-keys">
                <span>
                    <kbd className="sw-kbd">J</kbd>/<kbd className="sw-kbd">K</kbd> move and mark seen
                </span>
                <span>
                    <kbd className="sw-kbd">F</kbd> fix
                </span>
                <span>
                    <kbd className="sw-kbd">S</kbd> snooze
                </span>
                <span>
                    <kbd className="sw-kbd">B</kbd> backlog
                </span>
                <span>
                    <kbd className="sw-kbd">T</kbd> triage
                </span>
                <span>
                    <kbd className="sw-kbd">O</kbd> open in Bugsnag
                </span>
            </footer>
        </div>
    );
}

function rowOf(state: BugPageState, key: string): InboxItem | null {
    return state.items.find((item) => item.key === key) ?? null;
}

/** Fix, and a triage, need the Bugsnag project linked to a local project. */
function fixDisabled(projects: readonly BugsnagProjectSetting[], item: InboxItem | null): boolean {
    return !item || !projects.find((project) => project.id === item.source)?.localProject;
}

function emptyLine(page: BugPageState): string {
    if (!page.projects.some((project) => project.optedIn)) {
        return 'The Bug manager watches nothing yet: add a Bugsnag token and opt in its projects in Settings → Bug manager.';
    }
    if (page.tab !== 'inbox') return 'Nothing here.';
    return page.filter === 'all'
        ? 'Nothing to go through. The Bug manager will hold its glass up when there is.'
        : 'No bugs like that.';
}

function CheckedAgo({at}: {at: number | null}): JSX.Element | null {
    if (at === null) return <span>not checked yet</span>;
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
    return <span>checked {minutes === 0 ? 'just now' : `${minutes} min ago`}</span>;
}

function Filter({
    filter,
    label,
    page,
    tone,
}: {
    filter: Exclude<BugFilter, 'all'>;
    label: string;
    page: BugPageState;
    tone?: 'hot' | 'red' | 'cool';
}): JSX.Element {
    const on = page.tab === 'inbox' && page.filter === filter;
    return (
        <button
            type="button"
            className={'im-filter' + (tone ? ` is-${tone}` : '') + (on ? ' is-on' : '')}
            aria-pressed={on}
            onClick={() => chooseBugFilter(filter)}>
            {label}
        </button>
    );
}

// ── Rows ──

type Signal = 'trending' | 'regressed' | 'new' | 'plain';

function signalOf(item: InboxItem): Signal {
    if (item.signals?.regressed) return 'regressed';
    if (item.signals?.trending) return 'trending';
    if (item.signals?.new) return 'new';
    return 'plain';
}

const SIGNAL_LABEL: Record<Exclude<Signal, 'plain'>, string> = {
    trending: 'Trending',
    regressed: 'Regressed',
    new: 'New',
};

function bugTitle(facts: BugFacts): string {
    return [facts.errorClass, facts.message].filter(Boolean).join(': ') || facts.errorId;
}

/** A bug's signal chip; a plain open bug has none. */
function SignalChip({item}: {item: InboxItem}): JSX.Element | null {
    const signal = signalOf(item);
    return signal === 'plain' ? null : <span className={`bm-chip is-${signal}`}>{SIGNAL_LABEL[signal]}</span>;
}

const STAGE_TONE: Record<InboxStage, string> = {
    working: 'run',
    needsYou: 'need',
    prCi: 'ci',
    ciFailing: 'fail',
    ready: 'ready',
    queue: 'queue',
    merged: 'merged',
};

/** A bug's stage, in the words every place shares once its Fix's PR is landed (#441). */
function StagePill({item, stage}: {item: InboxItem; stage: InboxStage}): JSX.Element {
    const merge = useStore((state) => state.mergeManager.state);
    const pill = inProgressPill(stage, landedForItem(merge, item), item.fix?.queuePosition ?? null);
    const tone = pill.kind.startsWith('landed-') ? pill.kind : STAGE_TONE[stage];
    return (
        <span className={`bm-stage is-${tone}`} title={pill.title ?? undefined}>
            <i aria-hidden="true" />
            {pill.label}
        </span>
    );
}

/** A row's badge: the stage of a bug being fixed, Fixed or Seen again under Done, else its signal. */
function StateBadge({item}: {item: InboxItem}): JSX.Element | null {
    if (item.state.kind === 'inProgress') {
        return <StagePill item={item} stage={item.state.stage} />;
    }
    if (item.state.kind === 'done') {
        const again = item.fix?.seenAgain;
        return (
            <span className={`bm-stage is-${again ? 'need' : 'done'}`}>
                <i aria-hidden="true" />
                {again ? 'Seen again' : 'Fixed'}
            </span>
        );
    }
    return <SignalChip item={item} />;
}

/** What a row says of its state in place of where the bug happens: its Fix's PR, the snooze; null for a plain bug. */
function rowStatus(item: InboxItem): string | null {
    const work = item.fix;
    if (item.state.kind === 'inProgress' && work) {
        const pr = work.pr ? `PR #${work.pr.number}` : 'no PR yet';
        const checks = work.checks?.failing.length
            ? `${work.checks.failing.length} of ${work.checks.total} checks failing`
            : work.checks && work.checks.total > 0
              ? `${work.checks.passed} of ${work.checks.total} checks passed`
              : null;
        return [pr, checks].filter(Boolean).join(' · ');
    }
    if (item.state.kind === 'done' && work?.pr) {
        return `PR #${work.pr.number} merged${work.markedFixed ? ' · marked fixed in Bugsnag' : ''}`;
    }
    if (item.state.kind === 'read' && work?.ended === 'noPr') return 'Tried, no PR';
    if (item.state.kind === 'snoozed') {
        return item.state.until === null
            ? 'Snoozed until it changes'
            : `Snoozed until ${new Date(item.state.until).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'})}`;
    }
    return null;
}

/** A row's triage on its top line: running, stopped, or its verdict in a line. */
function RowTriage({triage}: {triage: BugTriage | null | undefined}): JSX.Element | null {
    const phase = triagePhase(triage);
    if (phase === 'none') return null;
    if (phase === 'running') return <span className="bm-triage-line is-running">◌ triaging…</span>;
    if (phase === 'stopped') return <span className="bm-triage-line is-stopped">triage stopped</span>;
    const verdict = triage!.verdict!;
    return (
        <span className="bm-triage-line" title={verdict.summary}>
            triaged:{' '}
            <b className={`bm-suggests is-${verdict.suggestion}`}>{TRIAGE_SUGGESTION_LABEL[verdict.suggestion]}</b>
            {verdict.summary ? ` — ${verdict.summary}` : ''}
        </span>
    );
}

function BugRow({item, page, selected}: {item: InboxItem; page: BugPageState; selected: boolean}): JSX.Element {
    const facts = item.facts as BugFacts;
    const signal = signalOf(item);
    const trend = page.trends[item.key];
    const notice = item.state.kind === 'done' ? item.fix?.seenAgain : null;
    const status = rowStatus(item);
    const times = timesItsAverage(facts);
    const firstSeen = relativeAge(facts.firstSeen);
    const lastSeen = relativeAge(facts.lastSeen);
    return (
        <div
            role="option"
            aria-selected={selected}
            data-bug-key={item.key}
            className={
                'bm-row' +
                ` bm-sig-${signal}` +
                (item.state.kind === 'unread' ? ' is-unread' : '') +
                (selected ? ' is-cursor' : '') +
                (notice ? ' is-seen-again' : '')
            }
            onClick={() => moveBugCursor(item.key)}>
            <span className="bm-dot" aria-label={item.state.kind === 'unread' ? 'unread' : undefined} />
            <span className="bm-row-text">
                <span className="bm-row-top">
                    <StateBadge item={item} />
                    {facts.severity && <span className={`bm-sev is-${facts.severity}`}>{facts.severity}</span>}
                    <RowTriage triage={item.triage} />
                </span>
                <b className="bm-row-title">
                    {facts.errorClass || facts.message ? (
                        <>
                            <span className="bm-row-class">{facts.errorClass}</span>
                            {facts.errorClass && facts.message ? ': ' : ''}
                            <span className="bm-row-msg">{facts.message}</span>
                        </>
                    ) : (
                        facts.errorId
                    )}
                </b>
                <span className="bm-row-meta">
                    {!notice && (status ? <span>{status}</span> : facts.context && <code>{facts.context}</code>)}
                    {firstSeen && <span>first seen {firstSeen}</span>}
                    {lastSeen && <span>last seen {lastSeen}</span>}
                </span>
            </span>
            <span className="bm-row-spark">
                <Sparkline
                    values={trend}
                    width={160}
                    height={40}
                    label={`${groupedCount(facts.events7d)} events in the last 7 days`}
                />
            </span>
            <span className="bm-nums">
                <span>
                    <b>{groupedCount(facts.events24h)}</b> today
                </span>
                {times !== null && <span className="bm-times">{times.toFixed(1)}× its average</span>}
                <span className="bm-nums-sub">
                    <b>{groupedCount(facts.users)}</b> users · {compactCount(facts.events)} all time
                </span>
            </span>
            {notice && (
                <span className="bm-seen-again">
                    {seenAgainLine(notice)}
                    <span className="bm-seen-again-actions">
                        <button
                            type="button"
                            className="sw-btn is-primary"
                            onClick={(e) => {
                                e.stopPropagation();
                                void closeBugAgain(item.key);
                            }}>
                            Close again
                        </button>
                        <button
                            type="button"
                            className="sw-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                void treatBugAsRegressed(item.key);
                            }}>
                            Treat as regressed
                        </button>
                    </span>
                </span>
            )}
        </div>
    );
}

// ── The detail ──

function BugDetailPane({item, page}: {item: InboxItem; page: BugPageState}): JSX.Element {
    const facts = item.facts as BugFacts;
    const detail = page.details[item.key];
    const source = sourceName(page.projects, item.source);
    const linkedTo = page.projects.find((project) => project.id === item.source)?.localProject ?? null;
    const average = facts.events7d / 7;
    const times = average > 0 ? facts.events24h / average : null;
    const work = item.fix;
    const inProgress = item.state.kind === 'inProgress';

    return (
        <div className="bm-detail-body" aria-label="Bug">
            <div className="bm-meta">
                <StateBadge item={item} />
                <span>
                    {source} (Bugsnag) →{' '}
                    {linkedTo ? linkedTo.split('/').pop() : <span className="bm-unlinked">not linked</span>}
                </span>
                <span>· severity {facts.severity || 'unknown'}</span>
            </div>
            <div className="bm-titlerow">
                <h2 className="bm-detail-title">{bugTitle(facts)}</h2>
                <button
                    type="button"
                    className="bm-out"
                    disabled={!detail?.url}
                    onClick={() => detail?.url && openInBrowser(detail.url)}>
                    Open in Bugsnag ↗
                </button>
            </div>
            {work?.pr && (inProgress || item.state.kind === 'done') && (
                <div>
                    <button type="button" className="bm-out is-gh" onClick={() => openInBrowser(work.pr!.url)}>
                        Open PR #{work.pr.number} in GitHub ↗
                    </button>
                </div>
            )}

            {inProgress && work ? (
                <>
                    <div className="bm-box">
                        <span className="bm-box-label">Where it is</span>
                        {work.timeline.map((step, i) => (
                            <div key={i} className="bm-step">
                                <i aria-hidden="true" />
                                <span>{step.text}</span>
                                <time>
                                    {new Date(step.at).toLocaleTimeString(undefined, {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                    })}
                                </time>
                            </div>
                        ))}
                        <div className="bm-step is-next">
                            <i aria-hidden="true" />
                            <span>Merge → marked fixed in Bugsnag</span>
                        </div>
                    </div>
                    {work.checks && work.checks.total > 0 && (
                        <div className="bm-box">
                            <span className="bm-box-label">
                                Checks · {work.checks.passed} of {work.checks.total} passed
                            </span>
                            {work.checks.failing.map((name) => (
                                <div key={name} className="bm-check is-bad">
                                    ✕ {name}
                                </div>
                            ))}
                        </div>
                    )}
                    <div className="bm-box">
                        <span className="bm-box-label">Session</span>
                        <span className="bm-session">
                            Worktree <code>{work.branch}</code>
                            {work.sessionEnded ? ' · ended' : ''}
                        </span>
                    </div>
                    <div className="bm-actions">
                        <button type="button" className="sw-btn is-primary" onClick={() => void openFixSession(item)}>
                            Open session <kbd className="sw-kbd">⏎</kbd>
                        </button>
                        <button type="button" className="sw-btn" onClick={() => void stopWorkingOnBug(item.key)}>
                            Stop working on it
                        </button>
                    </div>
                </>
            ) : (
                <>
                    {item.triage && <TriageBox item={item} triage={item.triage} />}
                    <div className="bm-box">
                        <span className="bm-box-label">Last 7 days</span>
                        <Sparkline
                            values={detail?.trend ?? page.trends[item.key]}
                            width={380}
                            height={64}
                            fluid
                            label={`${groupedCount(facts.events7d)} events in the last 7 days`}
                        />
                        <div className="bm-kv">
                            <div>
                                <b>{groupedCount(facts.users)}</b>
                                <span>users</span>
                            </div>
                            <div>
                                <b>{groupedCount(facts.events24h)}</b>
                                <span>events · 24 h</span>
                            </div>
                            <div>
                                <b>{times === null ? '—' : `${times.toFixed(1)}×`}</b>
                                <span>daily average</span>
                            </div>
                        </div>
                    </div>
                    {detail && detail.frames.length > 0 && (
                        <div className="bm-box">
                            <span className="bm-box-label">Where</span>
                            <div className="bm-stack">
                                {detail.frames.map((frame, i) => (
                                    <span key={i} className={frame.inProject ? 'is-own' : ''}>
                                        {frame.line}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}
                    {detail && (detail.first || detail.last) && (
                        <div className="bm-box">
                            <span className="bm-box-label">Releases</span>
                            <div className="bm-releases">
                                {detail.first && (
                                    <span>
                                        First seen <b>{detail.first.version ?? 'no version'}</b> on{' '}
                                        {shortDay(detail.first.at)}
                                    </span>
                                )}
                                {detail.last && (
                                    <span>
                                        {' '}
                                        · last seen <b>{detail.last.version ?? 'no version'}</b> on{' '}
                                        {shortDay(detail.last.at)}
                                    </span>
                                )}
                            </div>
                        </div>
                    )}
                    {detail?.mcpMissing && (
                        <p className="bm-hint">
                            Fix sessions read the error and link their PR with the bugsnag MCP, which is not installed.
                        </p>
                    )}
                    {item.state.kind !== 'done' && <SortActions item={item} page={page} />}
                </>
            )}
        </div>
    );
}

function shortDay(iso: string): string {
    const at = new Date(iso);
    return Number.isFinite(at.getTime()) ? at.toLocaleDateString(undefined, {day: 'numeric', month: 'short'}) : iso;
}

/**
 * A bug's quick triage in the detail: the errand while it reads, or what it
 * found, with its session a click away. It decides nothing; its suggestion
 * only picks the primary button below.
 */
function TriageBox({item, triage}: {item: InboxItem; triage: BugTriage}): JSX.Element {
    const phase = triagePhase(triage);
    const verdict = triage.verdict;
    const when = relativeAge(verdict?.at ?? triage.stoppedAt ?? triage.startedAt);
    return (
        <div
            className={'bm-box bm-triage' + (phase === 'running' ? ' is-running' : '')}
            aria-busy={phase === 'running'}>
            <div className="bm-triage-head">
                <span className="bm-box-label">Triage</span>
                <span className="bm-triage-when">
                    errand · {when}
                    {verdict && ` · ${verdict.confidence} confidence`}
                </span>
                <button type="button" className="bm-link" onClick={() => void openTriageSession(item)}>
                    Open session
                </button>
            </div>
            {phase === 'running' && (
                <p className="bm-triage-wait">Triaging… the errand is reading the error and the code.</p>
            )}
            {phase === 'stopped' && (
                <p className="bm-triage-stopped">
                    The errand stopped without a verdict. Open its session to see how far it got, or triage again.
                </p>
            )}
            {verdict && (
                <dl className="bm-triage-blocks">
                    <div>
                        <dt>What happened</dt>
                        <dd>{verdict.happened}</dd>
                    </div>
                    <div>
                        <dt>Why</dt>
                        <dd>
                            {verdict.why}
                            {verdict.where && <code className="bm-triage-where">{verdict.where}</code>}
                        </dd>
                    </div>
                    <div>
                        <dt>Impact</dt>
                        <dd>{verdict.impact}</dd>
                    </div>
                    <div>
                        <dt>Suggests</dt>
                        <dd>
                            <b className={`bm-suggests is-${verdict.suggestion}`}>
                                {TRIAGE_SUGGESTION_LABEL[verdict.suggestion]}
                            </b>
                            {verdict.summary && ` — ${verdict.summary}`}
                        </dd>
                    </div>
                </dl>
            )}
        </div>
    );
}

function SortActions({item, page}: {item: InboxItem; page: BugPageState}): JSX.Element {
    const unlinked = fixDisabled(page.projects, item);
    const fixing = page.fixing === item.key;
    const triaging = page.triaging === item.key;
    const snoozing = page.snooze?.key === item.key ? page.snooze : null;
    const phase = triagePhase(item.triage);
    const shown = new Set<BugSortAction>(['fix']);
    if (item.state.kind !== 'snoozed') shown.add('snooze');
    if (item.state.kind !== 'backlog') shown.add('backlog');
    const primary = primarySortAction(item.triage, shown);
    const kind = (action: BugSortAction): string => 'sw-btn' + (primary === action ? ' is-primary' : '');
    const withNotes = item.triage?.verdict?.suggestion === 'fix';
    return (
        <>
            <div className="bm-actions">
                <button
                    type="button"
                    className={kind('fix')}
                    disabled={unlinked || page.fixing !== null}
                    title={unlinked ? 'Link a project first' : `Fix on ${fixBranch((item.facts as BugFacts).errorId)}`}
                    onClick={() => void fixBug(item.key)}>
                    {fixing ? 'Starting…' : withNotes ? 'Fix with triage notes' : 'Fix'} <kbd className="sw-kbd">F</kbd>
                </button>
                {shown.has('snooze') && (
                    <button
                        type="button"
                        className={kind('snooze')}
                        aria-expanded={snoozing !== null}
                        onClick={() => (snoozing ? closeBugSnooze() : void openBugSnooze(item.key))}>
                        Snooze ▾ <kbd className="sw-kbd">S</kbd>
                    </button>
                )}
                {shown.has('backlog') && (
                    <button type="button" className={kind('backlog')} onClick={() => void backlogBug(item.key)}>
                        Backlog <kbd className="sw-kbd">B</kbd>
                    </button>
                )}
                {phase !== 'running' && (
                    <button
                        type="button"
                        className="sw-btn"
                        disabled={unlinked || page.triaging !== null}
                        title={unlinked ? 'Link a project first' : 'A quick read-only look at what happened'}
                        onClick={() => void triageBug(item.key)}>
                        {triaging ? 'Starting…' : phase === 'none' ? 'Triage' : 'Triage again'}{' '}
                        <kbd className="sw-kbd">T</kbd>
                    </button>
                )}
            </div>
            {unlinked && <p className="bm-hint">Link a project first: Settings → Bug manager.</p>}
            {snoozing && (
                <div className="bm-menu" role="menu" aria-label="Snooze until">
                    <span className="bm-menu-label">Snooze until</span>
                    {snoozing.options === null && <span className="bm-menu-wait">…</span>}
                    {snoozing.options?.map((option, i, all) => (
                        <div key={option.kind}>
                            {option.cycle && !all[i - 1]?.cycle && (
                                <span className="bm-menu-label">Cycle · from the Planner</span>
                            )}
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => void snoozeBug(item.key, option.until)}>
                                {option.label}
                                <span>{option.until ? shortDay(option.until) : 'trends or regresses'}</span>
                            </button>
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

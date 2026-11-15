/**
 * The Merge manager's page (#439, ⌘⇧L): what the main area shows while its
 * route is `mergeManager`. Its figure and where merging runs ("Merging on
 * this Mac" or on a VM, with the hand-off and bring-back, #442) in the
 * header, and what happened while merging was on a VM under it; the next
 * hour's turns on a timeline, one track per lane; every lane as a card,
 * grouped by repository with its kind, the head on top with three steps and
 * the rest in the lane's order (only the user's own PRs), each with when it
 * is expected to merge, or why it keeps its place; Merged today at the
 * bottom, with how long each took; and, once a row is chosen, its side view
 * beside them, per stage, with its actions and its expected time.
 *
 * Between the lanes and Merged today, Not landed: your newest open PRs not in
 * a lane yet, each with Land it (L), and View all for the Not landed page,
 * which the same panel shows instead of the lanes (`NotLandedPage`).
 *
 * What it shows is `domain/merge-manager/page` and `times`; its keys, while
 * it has the focus and never in a field, are `page-keys` (J/K go through the
 * lanes, then Not landed); Esc closes the side view, and then the page.
 *
 * Rendered into `#merge-manager-page`, which `ui/main-area/install-main-area`
 * shows and hides with the route.
 */
import {useEffect, useLayoutEffect, useRef, type JSX, type KeyboardEvent, type ReactNode} from 'react';
import {getState} from '../../state/app-store';
import {useStore} from '../use-store';
import {formatDate} from '../../lib/format';
import {SceneFigure} from '../bug-manager/ManagerFigure';
import {mergeFigureOf, type MergeFigure} from '../../../domain/merge-manager/figure';
import {ordinal} from '../../../domain/merge-manager/stage-words';
import {
    ciRunsSaved,
    dayStart,
    errandNotes,
    errandOf,
    headSteps,
    laneKindLabel,
    mergedToday,
    pageLanes,
    pageSubline,
    rowActions,
    rowStageLabel,
    savedText,
    type MergeManagerPageFacts,
    type PageLane,
    type PageRow,
} from '../../../domain/merge-manager/page';
import {
    checksSince,
    durationText,
    laneTimes,
    stillText,
    timeline,
    untilText,
    type LaneTimes,
    type RowTime,
    type Timeline,
} from '../../../domain/merge-manager/times';
import {QUEUE_STEP_MS} from '../../../domain/project/merge-queue';
import type {LandedView} from '../../../domain/merge-manager/model';
import type {MergeManagerPageState} from '../../state/merge-manager-slice';
import {mergeKeyAction, notLandedKeyAction} from './page-keys';
import {CloseIcon} from './CloseIcon';
import {NotLandedPage} from './NotLandedPage';
import {NotLandedDetail} from './NotLandedDetail';
import {NotLandedSection} from './NotLandedSection';
import {carryOutNotLandedKey} from './not-landed-actions';
import {
    notLandedSection,
    notLandedSubline,
    pageSelection,
    visibleRows,
    type PageSelection,
    type VisibleRows,
} from './not-landed-rows';
import {AwaySummaryBox, MergingHostPill} from './MergingHost';
import {
    closeMergeDetail,
    closeMergeManager,
    nudgeFromPage,
    openRowOnGitHub,
    openRowSession,
    selectMergeRow,
    sessionOf,
    stepMergeRow,
    toggleMergeRow,
    tryAgainFromPage,
    typeTryAgainNote,
    unlandFromPage,
} from './page-actions';

/** The letters the page's keys use (`page-keys`). */
const PAGE_LETTERS = new Set(['j', 'k', 't', 'n', 'u', 'o', 'l']);

const NO_TIMES: LaneTimes = {runMs: null, rows: new Map(), clearsAt: null};

export function MergeManagerPage(): JSX.Element | null {
    const open = useStore((state) => state.mainArea.route.kind === 'mergeManager');
    const view = useStore((state) => state.mergeManager.page.view);
    if (!open) return null;
    return view === 'notLanded' ? <NotLandedPage /> : <MergeManagerView />;
}

function sameFigure(a: MergeFigure, b: MergeFigure): boolean {
    return a.pose === b.pose && a.count === b.count;
}

/** The selected row (a lane's or a Not landed one) while its side view is open; null while it is closed. */
function openRow(rows: VisibleRows, page: MergeManagerPageState): PageSelection | null {
    return page.detailOpen ? pageSelection(rows, page.selected) : null;
}

function MergeManagerView(): JSX.Element {
    const root = useRef<HTMLDivElement>(null);
    const merge = useStore((state) => state.mergeManager.state);
    const page = useStore((state) => state.mergeManager.page);
    const open = useStore((state) => state.mergeManager.notLanded);
    const busy = useStore((state) => state.mergeManager.busy);
    const figure = useStore((state) => mergeFigureOf(state.mergeManager.state), sameFigure);
    const now = useStore((state) => state.sessionList.now) || Date.now();
    const today = dayStart(now);
    const lanes = pageLanes(merge);
    const merged = mergedToday(merge, today);
    const section = notLandedSection(open, merge);
    const selection = openRow({lanes, notLanded: section.rows}, page);
    const selected = selection?.kind === 'lane' ? selection.row : null;
    const selectedKey = selection?.key ?? null;
    const runMs = page.facts?.runMs ?? {};
    const times = new Map(
        lanes.map((lane) => [lane.repository, laneTimes(lane, runMs[lane.repository.toLowerCase()] ?? null, now)]),
    );
    const line = timeline(lanes, times, now);
    const saved = ciRunsSaved(page.facts?.savedThisWeek);

    // Into the page as it opens, so its keys reach it without a click.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, []);

    // The selected row stays in view.
    useEffect(() => {
        if (!selectedKey) return;
        root.current
            ?.querySelector(`[data-merge-key="${CSS.escape(selectedKey)}"]`)
            ?.scrollIntoView({block: 'nearest'});
    }, [selectedKey]);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (e.key === 'Escape') {
            e.preventDefault();
            if (target.matches('input, textarea')) root.current?.focus({preventScroll: true});
            else if (getState().mergeManager.page.detailOpen) {
                closeMergeDetail();
                root.current?.focus({preventScroll: true});
            } else closeMergeManager();
            return;
        }
        if (target.matches('input, textarea, select, [contenteditable="true"]')) return;
        // A focused button takes its own ⏎.
        if (e.key === 'Enter' && target !== root.current) return;
        if (e.shiftKey) return;
        const state = getState().mergeManager;
        const current = openRow(visibleRows(state), state.page);
        // The page's letters are its own even where a row does not offer them: N is Nudge, never a quick session.
        if (PAGE_LETTERS.has(e.key.toLowerCase())) {
            e.preventDefault();
            e.stopPropagation();
        }
        if (current?.kind === 'notLanded') {
            const offered = notLandedKeyAction(e.key, current.pr, sessionOf(current.pr) !== null);
            if (!offered) return;
            e.preventDefault();
            e.stopPropagation();
            carryOutNotLandedKey(offered, root.current);
            return;
        }
        const action = mergeKeyAction(e.key, current?.row ?? null);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        switch (action.kind) {
            case 'step':
                stepMergeRow(action.step);
                break;
            case 'open':
                void openRowSession(action.row);
                break;
            case 'tryAgain':
                void tryAgainFromPage(action.row);
                break;
            case 'nudge':
                void nudgeFromPage(action.row);
                break;
            case 'unland':
                void unlandFromPage(action.row);
                break;
            case 'github':
                openRowOnGitHub(action.row);
                break;
        }
    };

    const focusRows = (): void => root.current?.focus({preventScroll: true});
    const onSelect = (key: string): void => {
        toggleMergeRow(key);
        focusRows();
    };

    return (
        <div
            ref={root}
            className="sw-page mm-page"
            tabIndex={-1}
            role="region"
            aria-label="Merge manager"
            onKeyDown={onKeyDown}>
            <header className="sw-header pp-header">
                <div className="sw-header-row">
                    <button
                        type="button"
                        className="sw-btn sw-back"
                        onClick={closeMergeManager}
                        aria-label="Close the Merge manager (Esc)">
                        <CloseIcon />
                        Close <kbd className="sw-kbd">esc</kbd>
                    </button>
                    <SceneFigure scene={{kind: 'merge', state: figure.pose, count: figure.count, label: ''}} />
                    <div className="sw-heading">
                        <h1 className="sw-title pp-title">Merge manager</h1>
                        <div className="sw-subline pp-subline">
                            <span>
                                {pageSubline(lanes)}
                                {notLandedSubline(section.total)}
                                {saved > 0 && (
                                    <span title={savedText(page.facts?.savedThisWeek) ?? undefined}>
                                        {` · ${saved} CI ${saved === 1 ? 'run' : 'runs'} saved this week`}
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>
                    <MergingHostPill />
                </div>
            </header>

            <AwaySummaryBox />

            {page.notice && (
                <div className="tk-status" role="status">
                    {page.notice}
                </div>
            )}

            <div className={'mm-body' + (selection ? ' has-detail' : '')}>
                <div className="mm-list" role="listbox" aria-label="Lanes">
                    {lanes.length === 0 &&
                        (section.rows.length > 0 ? (
                            <NotLandedEmptyLine figure={figure} />
                        ) : (
                            <EmptyLine figure={figure} />
                        ))}
                    {line && <TimelineCard line={line} selected={selectedKey} onSelect={selectMergeRow} />}
                    {lanes.map((lane) => (
                        <Lane
                            key={lane.repository}
                            lane={lane}
                            times={times.get(lane.repository) ?? NO_TIMES}
                            now={now}
                            selected={selectedKey}
                            onSelect={onSelect}
                        />
                    ))}
                    <NotLandedSection
                        section={section}
                        now={now}
                        selected={selectedKey}
                        busy={busy}
                        onSelect={onSelect}
                    />
                    {merged.length > 0 && <MergedToday merged={merged} lanes={merge.lanes} />}
                </div>
                {selected && (
                    <Detail
                        row={selected}
                        lane={lanes.find((l) => l.repository === selected.repository)!}
                        times={times.get(selected.repository) ?? NO_TIMES}
                        page={page}
                        now={now}
                    />
                )}
                {selection?.kind === 'notLanded' && (
                    <NotLandedDetail pr={selection.pr} busy={busy[selection.key] === 'land'} />
                )}
            </div>

            <footer className="tk-keys" aria-label="Keys">
                <span>
                    <kbd className="sw-kbd">J</kbd>/<kbd className="sw-kbd">K</kbd> next, previous
                </span>
                <span>
                    <kbd className="sw-kbd">↵</kbd> open session or errand
                </span>
                <span>
                    <kbd className="sw-kbd">T</kbd> try again
                </span>
                <span>
                    <kbd className="sw-kbd">N</kbd> nudge
                </span>
                <span>
                    <kbd className="sw-kbd">U</kbd> unland
                </span>
                <span>
                    <kbd className="sw-kbd">O</kbd> open on GitHub
                </span>
                <span>
                    <kbd className="sw-kbd">L</kbd> land it
                </span>
            </footer>
        </div>
    );
}

/** Nothing landed: the Merge manager large, with how to land a pull request. */
function EmptyLine({figure}: {figure: MergeFigure}): JSX.Element {
    return (
        <div className="mm-empty">
            <SceneFigure
                scene={{kind: 'merge', state: figure.pose, count: figure.count, label: ''}}
                className="bm-figure mm-empty-figure"
            />
            <h2 className="mm-empty-title">Nothing to land yet</h2>
            <p>
                Press <b>Land it</b> on one of your own open pull requests: in the session header, a sidebar row&apos;s
                menu (<kbd className="sw-kbd">L</kbd>), the session tray or a project page&apos;s pull requests. From
                then on the Merge manager takes it to merged: it waits its turn in its repository&apos;s lane, is
                updated and tested only as the head, and is fixed by an errand when it fails out.
            </p>
        </div>
    );
}

/** Nothing landed, but Not landed has rows: one compact line with the small figure, pointing below. */
function NotLandedEmptyLine({figure}: {figure: MergeFigure}): JSX.Element {
    return (
        <div className="mm-empty-line">
            <SceneFigure scene={{kind: 'merge', state: figure.pose, count: figure.count, label: ''}} />
            <span>
                Nothing to land yet. Pick one below and press <kbd className="sw-kbd">L</kbd>.
            </span>
        </div>
    );
}

// ── The timeline ──

function TimelineCard({
    line,
    selected,
    onSelect,
}: {
    line: Timeline;
    selected: string | null;
    onSelect: (key: string) => void;
}): JSX.Element {
    const span = line.to - line.from;
    const left = (at: number): string => ((at - line.from) / span) * 100 + '%';
    const hours = span > 60 * 60_000;
    return (
        <section className="mm-card mm-timeline" aria-label="Coming up">
            <div className="mm-card-head">
                <h2>{hours ? `The next ${Math.round(span / 3_600_000)} hours` : 'The next hour'}</h2>
                {line.tracks.some((track) => track.blocks.some((block) => block.rough)) && (
                    <span>Dashed: rough, further back in its lane</span>
                )}
            </div>
            <div className="mm-tl">
                <div className="mm-tl-axis" aria-hidden="true">
                    <span className="is-now" style={{left: '0%'}}>
                        now
                    </span>
                    {line.ticks.map((at) => (
                        <span key={at} style={{left: left(at)}}>
                            {clock(at)}
                        </span>
                    ))}
                </div>
                {line.tracks.map((track) => (
                    <div key={track.repository} className="mm-tl-row">
                        <span className="mm-tl-name" title={track.repository}>
                            {repositoryName(track.repository)}
                        </span>
                        <div className="mm-tl-track">
                            {line.ticks.map((at) => (
                                <i key={at} className="mm-tl-tick" style={{left: left(at)}} aria-hidden="true" />
                            ))}
                            {track.blocks.map((block) => (
                                <button
                                    key={block.key}
                                    type="button"
                                    className={
                                        'mm-tl-block' +
                                        (block.head ? ' is-head' : '') +
                                        (block.rough ? ' is-rough' : '') +
                                        (block.key === selected ? ' is-selected' : '')
                                    }
                                    style={{
                                        left: block.start * 100 + '%',
                                        width: `max(6px, ${(block.end - block.start) * 100}%)`,
                                    }}
                                    title={`#${block.number}`}
                                    onClick={() => onSelect(block.key)}>
                                    #{block.number}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}

// ── The lanes ──

function Lane({
    lane,
    times,
    now,
    selected,
    onSelect,
}: {
    lane: PageLane;
    times: LaneTimes;
    now: number;
    selected: string | null;
    onSelect: (key: string) => void;
}): JSX.Element {
    return (
        <section className="mm-card mm-lanecard" role="group" aria-label={lane.repository}>
            <div className="mm-lanehead">
                <h2 title={lane.repository}>{repositoryName(lane.repository)}</h2>
                <span className={'mm-lane' + (lane.kind === 'switchboard' ? ' is-switchboard' : '')}>
                    {laneKindLabel(lane.kind)}
                </span>
                {lane.approvalLostOnPush && (
                    <span
                        className="mm-lane-warn"
                        title="A push to a PR here dismisses its approval or needs a new one">
                        updating the head loses its approval
                    </span>
                )}
                <span className="mm-lanehead-gap" />
                {times.runMs !== null && (
                    <span className="mm-lane-ci" title="The median of this repository's recent green CI runs">
                        CI ~{durationText(times.runMs)}
                    </span>
                )}
                {times.clearsAt !== null && <span className="mm-lane-clear">clear by ~{clock(times.clearsAt)}</span>}
            </div>
            {lane.rows.map((row) =>
                row.stage.kind === 'head' ? (
                    <div key={row.key} className="mm-headcard">
                        <Row
                            row={row}
                            time={times.rows.get(row.key)}
                            selected={selected === row.key}
                            onSelect={onSelect}
                        />
                        <ol className="mm-steps" aria-label="Where the head is">
                            {headSteps(row).map((step, index) => (
                                <li key={step.label} className={'mm-step is-' + step.state}>
                                    <span className="mm-step-label">
                                        <span>
                                            {step.state === 'done' && '✓ '}
                                            {step.label}
                                        </span>
                                        <span className="mm-step-time">
                                            {stepTime(index, step.state, row, times, now)}
                                        </span>
                                    </span>
                                    <span className="mm-bar">
                                        <span style={{width: Math.round(step.progress * 100) + '%'}} />
                                    </span>
                                </li>
                            ))}
                        </ol>
                    </div>
                ) : (
                    <Row
                        key={row.key}
                        row={row}
                        time={times.rows.get(row.key)}
                        selected={selected === row.key}
                        onSelect={onSelect}
                    />
                ),
            )}
        </section>
    );
}

/** What a head step says of its time: the checks' run so far against a whole one, the merge's clock. */
function stepTime(
    index: number,
    state: 'done' | 'active' | 'todo',
    row: PageRow,
    times: LaneTimes,
    now: number,
): string | null {
    const {runMs} = times;
    const time = times.rows.get(row.key);
    if (index === 0) return state === 'active' ? 'now' : null;
    if (index === 1) {
        if (runMs === null || state === 'done') return null;
        const since = checksSince(row.landed);
        if (state === 'active' && since !== null) {
            return `${durationText(now - since)} of ~${durationText(runMs)}`;
        }
        return state === 'todo' ? '~' + durationText(runMs) : null;
    }
    return time ? '~' + clock(time.at) : null;
}

function Row({
    row,
    time,
    selected,
    onSelect,
}: {
    row: PageRow;
    time: RowTime | undefined;
    selected: boolean;
    onSelect: (key: string) => void;
}): JSX.Element {
    return (
        <div
            role="option"
            aria-selected={selected}
            data-merge-key={row.key}
            className={'mm-row' + (selected ? ' is-selected' : '')}
            onClick={() => onSelect(row.key)}>
            <span className={'mm-place' + (row.stage.kind === 'head' ? ' is-head' : '')}>{row.order ?? '·'}</span>
            <span className="mm-row-text">
                <span className="mm-row-title">
                    <span className="mm-row-number">#{row.number}</span> {row.title}
                </span>
                <span className="mm-row-meta">
                    {rowMeta(row)}
                    {row.words.flag && <span className="mm-row-flag"> · {row.words.flag}</span>}
                </span>
            </span>
            <StagePill row={row} />
            <Eta row={row} time={time} />
        </div>
    );
}

/** When it merges ("~14:37", "in 17 min"), rough and faded further back; or why it keeps its place. */
function Eta({row, time}: {row: PageRow; time: RowTime | undefined}): JSX.Element {
    if (time) {
        return (
            <span className={'mm-eta' + (time.rough ? ' is-rough' : '')}>
                <b>~{clock(time.at)}</b>
                <span>{untilText(time)}</span>
            </span>
        );
    }
    return <span className="mm-eta is-still">{stillText(row)}</span>;
}

function StagePill({row}: {row: PageRow}): JSX.Element {
    return (
        <span
            className={'pp-stage is-landed-' + row.stage.kind + (row.words.tone === 'error' ? ' is-error' : '')}
            title={row.words.title}>
            <i aria-hidden="true" />
            {rowStageLabel(row)}
        </span>
    );
}

/** A row's second line: who approved it, and its branch. */
function rowMeta(row: PageRow): string {
    const approved = row.landed.facts?.approvedBy ?? [];
    const parts = [approved.length > 0 ? 'approved by ' + approved.join(', ') : null, row.landed.headRef].filter(
        (part): part is string => !!part,
    );
    return parts.join(' · ');
}

function MergedToday({
    merged,
    lanes,
}: {
    merged: readonly LandedView[];
    lanes: readonly {repository: string; pullRequests: readonly LandedView[]}[];
}): JSX.Element {
    const repositoryOf = (pr: LandedView): string =>
        lanes.find((lane) => lane.pullRequests.includes(pr))?.repository ?? pr.repository;
    return (
        <section className="mm-card mm-lanecard" role="group" aria-label="Merged today">
            <div className="mm-lanehead">
                <h2>Merged today</h2>
                <span className="mm-lanehead-meta">sessions archived · from landed to merged</span>
            </div>
            {merged.map((pr) => (
                <div
                    key={pr.key}
                    role="link"
                    tabIndex={0}
                    title="Open on GitHub"
                    className="mm-row is-merged"
                    onClick={() => openRowOnGitHub(pr)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') openRowOnGitHub(pr);
                    }}>
                    <span className="mm-place is-merged">✓</span>
                    <span className="mm-row-text">
                        <span className="mm-row-title">
                            <span className="mm-row-number">#{pr.number}</span> {pr.title}
                        </span>
                        <span className="mm-row-meta">
                            {repositoryName(repositoryOf(pr))} · landed {clock(pr.landedAt)}, merged{' '}
                            {pr.stage.kind === 'merged' ? clock(pr.stage.at) : ''}
                        </span>
                    </span>
                    <span className="pp-stage is-landed-merged">
                        <i aria-hidden="true" />
                        Merged
                    </span>
                    <span className="mm-eta">
                        {pr.stage.kind === 'merged' && <b>{durationText(pr.stage.at - pr.landedAt)}</b>}
                        <span>land to merge</span>
                    </span>
                </div>
            ))}
        </section>
    );
}

// ── The side view ──

function Detail({
    row,
    lane,
    times,
    page,
    now,
}: {
    row: PageRow;
    lane: PageLane;
    times: LaneTimes;
    page: MergeManagerPageState;
    now: number;
}): JSX.Element {
    const offers = rowActions(row);
    const time = times.rows.get(row.key) ?? null;
    const where =
        lane.kind === 'switchboard'
            ? `${ordinal(row.order ?? 1)} in land order`
            : row.order !== null
              ? `number ${row.order} in the merge queue`
              : 'out of the queue’s order';
    return (
        <aside className="mm-detail" aria-label={`#${row.number} ${row.title}`}>
            <div className="mm-detail-bar">
                <div className="mm-detail-where">
                    <StagePill row={row} />
                    <span>
                        {repositoryName(row.repository)} · {laneKindLabel(lane.kind)} · {where}
                    </span>
                </div>
                <button
                    type="button"
                    className="im-close"
                    onClick={closeMergeDetail}
                    aria-label="Close the side view (Esc)">
                    <CloseIcon />
                </button>
            </div>
            <h2 className="mm-title">
                #{row.number} {row.title}
            </h2>
            <button type="button" className="im-out mm-out" onClick={() => openRowOnGitHub(row)}>
                Open PR #{row.number} on GitHub ↗
            </button>
            {time && times.runMs !== null && (
                <EtaBox row={row} lane={lane} time={time} times={times} runMs={times.runMs} now={now} />
            )}
            <StageBody row={row} lane={lane} time={time} facts={page.facts} now={now} />
            {offers.tryAgain && <TryAgainBox row={row} page={page} />}
            <div className="im-actions">
                <button type="button" className="sw-btn is-primary" onClick={() => void openRowSession(row)}>
                    {offers.open.kind === 'errand' ? 'Open errand' : 'Open session'} <kbd className="sw-kbd">↵</kbd>
                </button>
                {offers.nudge && (
                    <button type="button" className="sw-btn" onClick={() => void nudgeFromPage(row)}>
                        Nudge {offers.nudge} <kbd className="sw-kbd">N</kbd>
                    </button>
                )}
                {offers.unland && (
                    <button type="button" className="sw-btn is-ghost" onClick={() => void unlandFromPage(row)}>
                        Unland <kbd className="sw-kbd">U</kbd>
                    </button>
                )}
            </div>
        </aside>
    );
}

/**
 * Expected to merge: its clock time, and what makes it up. A waiting PR's
 * wait for the turns ahead of it, its own update and checks, and its merge;
 * the head's run so far against a whole one.
 */
function EtaBox({
    row,
    lane,
    time,
    times,
    runMs,
    now,
}: {
    row: PageRow;
    lane: PageLane;
    time: RowTime;
    times: LaneTimes;
    runMs: number;
    now: number;
}): JSX.Element {
    const head = row.stage.kind === 'head';
    const since = head ? checksSince(row.landed) : null;
    const wait = Math.max(0, time.from - now);
    const ahead = lane.rows
        .slice(0, lane.rows.indexOf(row))
        .filter((candidate) => times.rows.has(candidate.key))
        .pop();
    const parts = head
        ? []
        : [
              {
                  ms: wait,
                  label: lane.kind === 'switchboard' && ahead ? `#${ahead.number} merges` : 'the turns ahead',
                  tone: 'ahead',
              },
              {ms: runMs, label: 'update and checks', tone: 'run'},
              {ms: QUEUE_STEP_MS, label: 'merge', tone: 'merge'},
          ].filter((part) => part.ms >= 30_000);
    const ran = since !== null && row.stage.kind === 'head' && row.stage.step === 'checks' ? now - since : null;
    return (
        <div className={'mm-etabox' + (time.rough ? ' is-rough' : '')}>
            <span className="im-box-label">Expected to merge</span>
            <div className="mm-etabox-time">
                <b>~{clock(time.at)}</b>
                <span>{untilText(time)}</span>
            </div>
            {parts.length > 0 && (
                <>
                    <div className="mm-etabar" aria-hidden="true">
                        {parts.map((part) => (
                            <span key={part.tone} className={'is-' + part.tone} style={{flexGrow: part.ms}} />
                        ))}
                    </div>
                    <div className="mm-etaparts">
                        {parts.map((part) => (
                            <div key={part.tone} className={'is-' + part.tone}>
                                <b>~{durationText(part.ms)}</b>
                                <span>{part.label}</span>
                            </div>
                        ))}
                    </div>
                </>
            )}
            {ran !== null && (
                <>
                    <div className="mm-etabar" aria-hidden="true">
                        <span className="is-head" style={{flexGrow: Math.min(ran, runMs)}} />
                        <span className="is-left" style={{flexGrow: Math.max(0, runMs - ran)}} />
                    </div>
                    <p className="mm-quiet">
                        {durationText(ran)} into a run that usually takes {durationText(runMs)}.
                    </p>
                </>
            )}
            <p className="mm-quiet">
                From the median of this repository’s recent green CI runs.
                {time.rough && ' Rough this far back in the lane.'}
            </p>
        </div>
    );
}

function Box({label, children, tone}: {label: string; children: ReactNode; tone?: 'warn'}): JSX.Element {
    return (
        <div className={'im-box' + (tone ? ' is-' + tone : '')}>
            <span className="im-box-label">{label}</span>
            {children}
        </div>
    );
}

function Step({
    tone,
    children,
    at,
}: {
    tone?: 'purple' | 'yellow' | 'green' | 'red';
    children: ReactNode;
    at?: string;
}): JSX.Element {
    return (
        <div className={'mm-vstep' + (tone ? ' is-' + tone : '')}>
            <i aria-hidden="true" />
            <div>{children}</div>
            <span>{at ?? ''}</span>
        </div>
    );
}

function StageBody({
    row,
    lane,
    time,
    facts,
    now,
}: {
    row: PageRow;
    lane: PageLane;
    time: RowTime | null;
    facts: MergeManagerPageFacts | null;
    now: number;
}): JSX.Element | null {
    const {stage} = row;
    switch (stage.kind) {
        case 'head':
            return <HeadBody row={row} lane={lane} time={time} facts={facts} />;
        case 'waiting':
            return (
                <Box label="Where it is">
                    <Step tone="purple" at={clock(row.landed.landedAt)}>
                        <b>Landed</b>
                    </Step>
                    <Step tone="green" at="now">
                        <b>Waiting</b> ·{' '}
                        {lane.kind === 'switchboard'
                            ? 'not updated until it is the head, so it spends no CI'
                            : `number ${row.order ?? '?'} in the merge queue, which holds its CI back`}
                    </Step>
                    <Step at={time ? '~' + clock(time.from) : undefined}>
                        <b>Head</b> ·{' '}
                        {lane.kind === 'switchboard' ? 'updated on the trunk (rebase)' : 'rebased by the queue'}, then
                        its checks
                    </Step>
                    <Step at={time ? '~' + clock(time.at) : undefined}>Merge · the session archives with confetti</Step>
                    {row.words.flag && (
                        <p className="mm-warn">
                            It will conflict with the trunk. A fix errand starts only once it is the head, so the fix is
                            not stale by then.
                        </p>
                    )}
                </Box>
            );
        case 'held':
            return <HeldBody row={row} />;
        case 'fixing':
            return <FixingBody row={row} facts={facts} now={now} />;
        case 'needsYou':
            return <NeedsYouBody row={row} />;
        case 'merged':
            return null;
    }
}

function HeadBody({
    row,
    lane,
    time,
    facts,
}: {
    row: PageRow;
    lane: PageLane;
    time: RowTime | null;
    facts: MergeManagerPageFacts | null;
}): JSX.Element {
    const checks = row.landed.facts?.checks ?? [];
    const passed = checks.filter((check) => check.state === 'passed' || check.state === 'skipped').length;
    const steps = headSteps(row);
    const tone = (index: number): 'purple' | 'yellow' | undefined =>
        steps[index]?.state === 'done' ? 'purple' : steps[index]?.state === 'active' ? 'yellow' : undefined;
    const saved = savedText(facts?.savedByRepository[lane.repository.toLowerCase()]);
    const since = checksSince(row.landed);
    return (
        <>
            <Box label="Where it is">
                <Step tone="purple" at={clock(row.landed.landedAt)}>
                    <b>Landed</b>
                </Step>
                <Step tone={tone(0)}>
                    <b>Head</b> ·{' '}
                    {lane.kind === 'switchboard' ? 'updated on the trunk (rebase)' : 'rebased by the queue'}
                </Step>
                <Step tone={tone(1)} at={since !== null ? clock(since) : undefined}>
                    <b>{steps[1]?.label ?? 'Checks'}</b>
                </Step>
                <Step tone={tone(2)} at={time ? '~' + clock(time.at) : undefined}>
                    Merge · the session archives with confetti
                </Step>
            </Box>
            {checks.length > 0 && (
                <Box label={`Required checks · ${passed} of ${checks.length} passed`}>
                    <div className="mm-checks">
                        {checks.map((check) => (
                            <div key={check.name} className={'is-' + check.state}>
                                {CHECK_MARK[check.state]} <span>{check.name}</span>
                            </div>
                        ))}
                    </div>
                </Box>
            )}
            {lane.kind === 'switchboard' && (
                <Box label="CI this lane saved this week">
                    <p>{saved ?? 'Nothing yet this week.'}</p>
                </Box>
            )}
        </>
    );
}

const CHECK_MARK: Record<string, string> = {
    passed: '✓',
    skipped: '✓',
    failed: '✗',
    cancelled: '⊘',
    running: '◌',
    queued: '◌',
    missing: '◌',
};

function HeldBody({row}: {row: PageRow}): JSX.Element {
    if (row.stage.kind !== 'held') return <></>;
    const {reason} = row.stage;
    switch (reason.kind) {
        case 'base':
            return (
                <Box label="Stacked">
                    <p>
                        {row.words.title}. Then it is retargeted to the trunk, and a fix errand rebases it with{' '}
                        <code>--onto</code> past the merged commits only if that leaves conflicts.
                    </p>
                </Box>
            );
        case 'review':
            return (
                <Box label="Held · keeps its place">
                    <p>
                        A review is requested from {reason.team ? 'the team ' : '@'}
                        {reason.reviewer}. Passed over until {reason.team ? 'it reviews' : 'they review'}; then it goes
                        back to its place.
                    </p>
                </Box>
            );
        case 'approval':
            return (
                <Box label="Held · keeps its place">
                    <p>Held until it is approved. Switchboard never approves; it keeps its place meanwhile.</p>
                </Box>
            );
        case 'draft':
            return (
                <Box label="Held · keeps its place">
                    <p>Held while it is a draft. Mark it ready for review and it goes back to its place.</p>
                </Box>
            );
    }
}

function FixingBody({row, facts, now}: {row: PageRow; facts: MergeManagerPageFacts | null; now: number}): JSX.Element {
    const errand = errandOf(facts, row.key);
    const cause = row.stage.kind === 'fixing' ? row.stage.cause : 'checks';
    const running = errand?.state === 'running';
    const minutes = errand ? Math.max(0, Math.round((now - errand.startedAt) / 60_000)) : null;
    const notes = errandNotes(facts, row.key);
    return (
        <>
            <Box label={running && minutes !== null ? `Fix errand · running ${minutes} min` : 'Fix errand'}>
                <Step tone="red">
                    <b>Failed out as the head</b> ·{' '}
                    {cause === 'conflict' ? 'a conflict with the trunk' : 'a failed required check'}
                </Step>
                <Step tone={running ? 'yellow' : undefined} at={errand ? clock(errand.startedAt) : undefined}>
                    {errand ? (
                        <>
                            <b>Errand</b> {cause === 'conflict' ? 'rebasing' : 'fixing the checks'} in its own worktree
                        </>
                    ) : (
                        'An errand starts on the next read'
                    )}
                </Step>
                <Step>Pushes the fix → back to its place in the lane, and it gets a time again</Step>
            </Box>
            <Box label="Runs on this Mac">
                <p>
                    It may push this branch, rebase it and run the tests. It never merges, labels, reviews, or touches
                    another branch.
                </p>
            </Box>
            {notes.length > 0 && (
                <Box label="Earlier errands said">
                    {notes.map((note) => (
                        <p key={note.sessionId + note.startedAt}>
                            {formatDate(new Date(note.startedAt), now)}: {note.note}
                        </p>
                    ))}
                </Box>
            )}
        </>
    );
}

function NeedsYouBody({row}: {row: PageRow}): JSX.Element {
    if (row.stage.kind !== 'needsYou') return <></>;
    const {reason} = row.stage;
    const what =
        reason.kind === 'changes-requested' || reason.kind === 'unresolved-thread'
            ? 'Review feedback is never fixed by an errand. Push a change or resolve the thread and it goes back to its place by itself.'
            : reason.kind === 'errand-stopped'
              ? 'Answer the errand in its session, push a commit, or Try again with a note for the next errand.'
              : 'Push a commit and it goes back to its place by itself, or Try again: with a note a fix errand takes it on.';
    return (
        <Box label="Needs you · keeps its place">
            <p>
                <b>{row.words.title.replace(/^Needs you: /, '')}</b>
            </p>
            <p className="mm-quiet">{what}</p>
        </Box>
    );
}

function TryAgainBox({row, page}: {row: PageRow; page: MergeManagerPageState}): JSX.Element {
    const busy = page.tryAgain[row.key]?.phase === 'busy';
    const failed = page.tryAgain[row.key];
    // Review feedback is never an errand's: Try again only reads it again.
    const review =
        row.stage.kind === 'needsYou' &&
        (row.stage.reason.kind === 'changes-requested' || row.stage.reason.kind === 'unresolved-thread');
    return (
        <div className="im-box mm-try">
            {!review && (
                <label className="im-box-label" htmlFor={'mm-note-' + row.number}>
                    A note for the next errand (optional)
                </label>
            )}
            {!review && (
                <textarea
                    id={'mm-note-' + row.number}
                    className="im-notes"
                    placeholder="What it should know, or try differently"
                    value={page.notes[row.key] ?? ''}
                    onChange={(e) => typeTryAgainNote(row.key, e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            void tryAgainFromPage(row);
                        }
                    }}
                />
            )}
            {failed?.phase === 'failed' && <p className="is-error">{failed.reason}</p>}
            <div className="im-actions">
                <button type="button" className="sw-btn" disabled={busy} onClick={() => void tryAgainFromPage(row)}>
                    {busy ? 'Starting…' : 'Try again'} <kbd className="sw-kbd">T</kbd>
                </button>
            </div>
        </div>
    );
}

/** "switchboard" for `movelab/switchboard`. */
function repositoryName(repository: string): string {
    return repository.split('/').pop() ?? repository;
}

/** "14:02", in the local time. */
function clock(at: number): string {
    return new Date(at).toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'});
}

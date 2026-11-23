/**
 * The Automatic shelf: the sessions Switchboard started by itself (the Merge
 * manager's fix errands, the merge queue's Nudge and Fix, the Bug manager's
 * quick triage) and the runs of the user's schedules, docked under the
 * session list instead of ranked among the user's own rows.
 *
 * Rendered into `#sidebar-errands`, between `#sidebar-content` and the
 * footer, so it stays put while the list scrolls. Shown while any errand or
 * scheduled run is listed, or any schedule is on (so the folded line can say
 * "next 03:00"); hidden otherwise, and while filtering, when the layout
 * leaves `errands` empty and the errands show inline among the matches.
 *
 * Folded, it is one line: "Automatic", how many rows it holds, and how many
 * need you, are left to read, are running, or when the next run is. The ones
 * that need you also ask in Blocked. Open, its sections ease in under the
 * header like a pinned section's entries: Running (errands and runs going
 * now), Last night (runs that ended and are not seen yet, with an unread
 * dot) and Coming up (the next schedule times, dim), then the links to the
 * managers behind them. The shelf never takes more than a third of the
 * sidebar; beyond that its rows scroll inside it.
 *
 * A row archived from here (its archive button, or `e` with the keyboard
 * cursor on it) slides out like a list row (`leave`). One that leaves because
 * its errand archived itself, or its run was seen, is simply removed: nothing
 * presses a button for it, so there is nothing to slide out from.
 */
import {formatDate} from '../../lib/format';
import {highlightedSession} from '../../state/main-area-slice';
import {shallowEqual} from '../../state/store';
import {useStore} from '../use-store';
import {openLink} from '../pr-view/actions';
import {openMergeManager} from '../merge-manager/page-actions';
import {openScheduleManager} from '../schedule-manager/actions';
import {clockTime} from '../../../domain/schedule/shelf';
import {isEndedRun} from '../../state/session-list-layout';
import {openRow, stopRow, toggleArchive, toggleErrandShelf} from './actions';
import {isLeaving} from './leave';
import {HTML} from './markup';
import {ErrandGlyph} from './ErrandGlyph';
import {automaticShelf, errandPlace, errandPullRequestUrl, errandRowName, runRowName} from './errand-view';
import type {CSSProperties, JSX, MouseEvent, ReactNode} from 'react';
import type {LaidErrand} from '../../state/session-list-layout';
import type {ScheduleManagerFacts} from '../../../domain/schedule/manager';
import type {ComingUpRun, ShelfRun} from '../../../domain/schedule/shelf';
import type {ShelfRow} from './errand-view';

/** The id the keyboard cursor gives the shelf's header. */
export const ERRAND_SHELF_HEADER_ID = 'errand-shelf-header';

const NO_ERRANDS: readonly LaidErrand[] = [];

export function ErrandShelf(): JSX.Element | null {
    const props = useStore(
        (s) => ({
            errands: s.sessionList.layout?.errands ?? NO_ERRANDS,
            schedules: s.scheduleManager.facts,
            // No layout yet is no list yet: nothing to dock under.
            filtering: s.sessionList.layout?.filtering ?? true,
            open: s.sessionList.errandShelfOpen,
            cursor: s.sessionList.cursor,
            onScreen: highlightedSession(s.mainArea),
            now: s.sessionList.now,
            leaving: s.sessionList.leaving,
        }),
        shallowEqual,
    );
    return <ErrandShelfView {...props} actions={ERRAND_ACTIONS} />;
}

/** What the shelf's controls do; the view takes them so it draws without the store. */
export interface ErrandShelfActions {
    toggle(): void;
    /** A session's row: open the session (which marks a scheduled run seen, see `openRow`). */
    open(rowId: string, sessionId: string): void;
    openPullRequest(url: string): void;
    stop(sessionId: string): void;
    /** Archive the session, sliding `row` out; `button` is what was pressed. */
    archive(row: HTMLElement, rowId: string, sessionId: string, button: HTMLElement): void;
    /** A run without a session of its own, or Coming up: that schedule's page, or the overview. */
    openSchedule(key: string | null): void;
    markSeen(runId: string): void;
    markAllSeen(): void;
    openMergeManager(): void;
}

const ERRAND_ACTIONS: ErrandShelfActions = {
    toggle: () => toggleErrandShelf(),
    open: (rowId, sessionId) => openRow(rowId, sessionId),
    openPullRequest: openLink,
    stop: stopRow,
    archive: toggleArchive,
    openSchedule: (key) => openScheduleManager(key),
    markSeen: (runId) => void window.api.scheduleManagerMarkSeen(runId),
    markAllSeen: () => void window.api.scheduleManagerMarkAllSeen(),
    openMergeManager: () => openMergeManager(),
};

export interface ErrandShelfViewProps {
    /** The errands' sessions, in the layout's order (`orderErrands`). */
    errands: readonly LaidErrand[];
    /** What main last pushed of the Schedule manager; null until it first answers. */
    schedules: ScheduleManagerFacts | null;
    /** A filter or a search is on: the shelf hides. */
    filtering: boolean;
    open: boolean;
    /** The keyboard cursor's element id. */
    cursor: string | null;
    /** The session on screen, whose row is tinted. */
    onScreen: string | null;
    now: number;
    /** The element ids on their way out (`sessionList.leaving`). */
    leaving: Readonly<Record<string, true | undefined>>;
    actions: ErrandShelfActions;
}

/** The shelf's markup, from what it shows. */
export function ErrandShelfView({
    errands,
    schedules,
    filtering,
    open,
    cursor,
    onScreen,
    now,
    leaving,
    actions,
}: ErrandShelfViewProps): JSX.Element | null {
    const shelf = automaticShelf(errands, schedules, now, filtering);
    if (!shelf) return null;
    const {summary} = shelf;

    const row = (shelfRow: ShelfRow): JSX.Element =>
        shelfRow.kind === 'session' ? (
            <ErrandRow
                key={shelfRow.laid.entry.id}
                laid={shelfRow.laid}
                cursor={cursor === shelfRow.laid.entry.id}
                onScreen={onScreen === shelfRow.laid.entry.session.sessionId}
                now={now}
                leaving={!!leaving[shelfRow.laid.entry.id]}
                actions={actions}
            />
        ) : (
            <RunRow key={'run-' + shelfRow.run.id} run={shelfRow.run} actions={actions} />
        );

    // Everything under the header, in order, each easing in after the one above it.
    const entries: {key: string; node: ReactNode}[] = [];
    const section = (label: string, rows: readonly JSX.Element[]): void => {
        if (rows.length === 0) return;
        entries.push({key: 'label-' + label, node: <div className="errand-shelf-section">{label}</div>});
        for (const node of rows) entries.push({key: String(node.key), node});
    };
    section('Running', shelf.running.map(row));
    section('Last night', shelf.lastNight.map(row));
    section(
        'Coming up',
        shelf.comingUp.map((next) => <ComingUpRow key={'next-' + next.scheduleKey} next={next} actions={actions} />),
    );
    const links: JSX.Element[] = [];
    if (shelf.lastNight.length > 0)
        links.push(
            <button key="read" type="button" className="errand-shelf-link" onClick={actions.markAllSeen}>
                Mark all read
            </button>,
        );
    if (shelf.scheduleManagerLink)
        links.push(
            <button
                key="schedule"
                type="button"
                className="errand-shelf-link"
                onClick={() => actions.openSchedule(null)}>
                Schedule manager
            </button>,
        );
    if (shelf.mergeManagerLink)
        links.push(
            <button key="merge" type="button" className="errand-shelf-link" onClick={actions.openMergeManager}>
                Merge manager
            </button>,
        );
    if (links.length > 0)
        entries.push({
            key: 'links',
            node: <div className="errand-shelf-links">{links}</div>,
        });

    return (
        <section className="errand-shelf" data-testid="errand-shelf" aria-label="Automatic">
            <button
                type="button"
                className={
                    'errand-shelf-header' +
                    (open ? '' : ' is-folded') +
                    (cursor === ERRAND_SHELF_HEADER_ID ? ' kbd-cursor' : '')
                }
                id={ERRAND_SHELF_HEADER_ID}
                aria-expanded={open}
                aria-controls="errand-shelf-body"
                onClick={actions.toggle}>
                <span className="session-section-chevron" aria-hidden="true">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                        <path
                            d="M3 2l4 3-4 3"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                </span>
                <span className="errand-shelf-label">Automatic</span>
                {shelf.count > 0 && <span className="errand-shelf-count">{shelf.count}</span>}
                <span className="errand-shelf-summary">
                    {summary.needsYou && <span className="errand-shelf-needs-you">{summary.needsYou}</span>}
                    {summary.rest && (
                        <span className="errand-shelf-rest">{(summary.needsYou ? '· ' : '') + summary.rest}</span>
                    )}
                </span>
            </button>
            {entries.length > 0 && (
                <div className="errand-shelf-scroll">
                    <div
                        className={'errand-shelf-body' + (open ? '' : ' is-folded')}
                        id="errand-shelf-body"
                        inert={!open}>
                        <div className="errand-shelf-rows">
                            {entries.map(({key, node}, i) => (
                                <div
                                    key={key}
                                    className="errand-shelf-entry"
                                    style={{'--i': i, '--n': entries.length} as CSSProperties}>
                                    {node}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

interface ErrandRowProps {
    laid: LaidErrand;
    cursor: boolean;
    onScreen: boolean;
    now: number;
    leaving: boolean;
    actions: ErrandShelfActions;
}

/**
 * One errand on one line: its kind, `#431 · fixing checks` (or `Triage · `
 * and the bug's title, or a run's schedule and how it goes), and where it
 * runs and how long ago it started, which give way to PR ↗ (not for a
 * triage or a run, which have no PR), Stop and archive on hover. A run that
 * ended shows an unread dot instead, and has nothing left to stop. A click anywhere else opens its session, as a sidebar row's does.
 * The archive button is the one the keyboard's `e` presses
 * (`.session-archive-btn`). Renaming is not offered: the name is the errand's.
 */
function ErrandRow({laid, cursor, onScreen, now, leaving, actions}: ErrandRowProps): JSX.Element {
    const {entry, errand} = laid;
    const {sessionId} = entry.session;
    const name = errandRowName(errand);
    const pullRequestUrl = errandPullRequestUrl(errand);
    const ended = isEndedRun(errand);
    const button =
        (handler: (pressed: HTMLButtonElement) => void) =>
        (e: MouseEvent<HTMLButtonElement>): void => {
            // The row's click opens the session; these are the buttons' own.
            e.stopPropagation();
            if (!isLeaving(entry.id)) handler(e.currentTarget);
        };
    return (
        <div
            className={
                'errand-row' +
                (errand.needsYou ? ' needs-you' : '') +
                (onScreen ? ' active' : '') +
                (cursor ? ' kbd-cursor' : '')
            }
            id={entry.id}
            data-session-id={sessionId}
            data-kind={errand.kind}
            data-leaving={leaving ? '' : undefined}
            title={name}
            onClick={() => actions.open(entry.id, sessionId)}>
            <ErrandGlyph kind={errand.kind} className="errand-row-glyph" />
            <span className="errand-row-name">{name}</span>
            {ended ? (
                <UnreadDot />
            ) : (
                <span className="errand-row-meta">
                    {errandPlace(errand)} · {formatDate(new Date(entry.session.created), now)}
                </span>
            )}
            <span className="errand-row-actions">
                {pullRequestUrl && (
                    <button
                        type="button"
                        className="errand-row-btn"
                        title={`Open #${errand.number} in the browser`}
                        onClick={button(() => actions.openPullRequest(pullRequestUrl))}>
                        PR ↗
                    </button>
                )}
                {!ended && (
                    <button
                        type="button"
                        className="errand-row-btn is-stop"
                        title="Stop"
                        onClick={button(() => actions.stop(sessionId))}>
                        Stop
                    </button>
                )}
                <button
                    type="button"
                    className="errand-row-btn session-archive-btn"
                    title="Archive"
                    aria-label="Archive"
                    dangerouslySetInnerHTML={HTML.archive14}
                    onClick={button((pressed) => {
                        const row = pressed.closest<HTMLElement>('.errand-row');
                        if (row) actions.archive(row, entry.id, sessionId, pressed);
                    })}
                />
            </span>
        </div>
    );
}

/** A run not seen yet: red when it needs you (the row's colour), else the accent. */
function UnreadDot(): JSX.Element {
    return <span className="errand-row-unread" aria-label="Not read yet" />;
}

/**
 * A scheduled run the shelf has no session row for: one that never started
 * (missed, skipped) or whose session the list does not hold. A click opens
 * its schedule's page, where the run is, and marks an ended one seen.
 */
function RunRow({run, actions}: {run: ShelfRun; actions: ErrandShelfActions}): JSX.Element {
    const name = runRowName(run);
    const ended = run.status !== 'running';
    return (
        <div
            className={'errand-row is-run' + (run.needsYou ? ' needs-you' : '')}
            data-run-id={run.id}
            data-kind="scheduled"
            title={run.reason ? `${name}: ${run.reason}` : name}
            onClick={() => {
                if (ended) actions.markSeen(run.id);
                actions.openSchedule(run.scheduleKey);
            }}>
            <ErrandGlyph kind="scheduled" className="errand-row-glyph" />
            <span className="errand-row-name">{name}</span>
            {ended && <UnreadDot />}
        </div>
    );
}

/** A schedule's next time, dim: there is no session yet. A click opens its page. */
function ComingUpRow({next, actions}: {next: ComingUpRun; actions: ErrandShelfActions}): JSX.Element {
    return (
        <div
            className="errand-row is-coming-up"
            data-schedule-key={next.scheduleKey}
            title={`${next.name} runs at ${clockTime(next.at)}`}
            onClick={() => actions.openSchedule(next.scheduleKey)}>
            <ErrandGlyph kind="scheduled" className="errand-row-glyph" />
            <span className="errand-row-name">{next.name}</span>
            <span className="errand-row-meta">{clockTime(next.at)}</span>
        </div>
    );
}

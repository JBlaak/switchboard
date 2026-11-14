/**
 * The Errands shelf: the sessions Switchboard started by itself for a pull
 * request (the Merge manager's fix errands, the merge queue's Nudge and Fix),
 * docked under the session list instead of ranked among the user's own rows.
 *
 * Rendered into `#sidebar-errands`, between `#sidebar-content` and the
 * footer, so it stays put while the list scrolls. Hidden while there is no
 * errand, and while filtering, when the layout leaves `errands` empty and the
 * errands show inline among the matches.
 *
 * Folded, only the errands that need you show under the header: those are
 * the ones the user has to act on. Open, the rest ease in below them like a
 * pinned section's entries. The shelf never takes more than a third of the
 * sidebar; beyond that its rows scroll inside it.
 *
 * A row archived from here (its archive button, or `e` with the keyboard
 * cursor on it) slides out like a list row (`leave`). One that leaves because
 * its errand archived itself is simply removed: nothing presses a button for
 * it, so there is nothing to slide out from.
 */
import {formatDate} from '../../lib/format';
import {highlightedSession} from '../../state/main-area-slice';
import {shallowEqual} from '../../state/store';
import {useStore} from '../use-store';
import {openLink} from '../pr-view/actions';
import {openRow, stopRow, toggleArchive, toggleErrandShelf} from './actions';
import {isLeaving} from './leave';
import {HTML} from './markup';
import {ErrandGlyph} from './ErrandGlyph';
import {errandPlace, errandPullRequestUrl, errandRowName, errandShelfSummary} from './errand-view';
import type {CSSProperties, JSX, MouseEvent} from 'react';
import type {LaidErrand} from '../../state/session-list-layout';

/** The id the keyboard cursor gives the shelf's header. */
export const ERRAND_SHELF_HEADER_ID = 'errand-shelf-header';

const NO_ERRANDS: readonly LaidErrand[] = [];

export function ErrandShelf(): JSX.Element | null {
    const props = useStore(
        (s) => ({
            errands: s.sessionList.layout?.errands ?? NO_ERRANDS,
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
    open(rowId: string, sessionId: string): void;
    openPullRequest(url: string): void;
    stop(sessionId: string): void;
    /** Archive the session, sliding `row` out; `button` is what was pressed. */
    archive(row: HTMLElement, rowId: string, sessionId: string, button: HTMLElement): void;
}

const ERRAND_ACTIONS: ErrandShelfActions = {
    toggle: () => toggleErrandShelf(),
    open: (rowId, sessionId) => openRow(rowId, sessionId),
    openPullRequest: openLink,
    stop: stopRow,
    archive: toggleArchive,
};

export interface ErrandShelfViewProps {
    errands: readonly LaidErrand[];
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
    open,
    cursor,
    onScreen,
    now,
    leaving,
    actions,
}: ErrandShelfViewProps): JSX.Element | null {
    if (errands.length === 0) return null;
    const summary = errandShelfSummary(errands);
    // The layout puts the ones that need you first; they stay out while folded.
    const stuck = errands.filter(({errand}) => errand.needsYou);
    const rest = errands.filter(({errand}) => !errand.needsYou);
    const row = (laid: LaidErrand): JSX.Element => (
        <ErrandRow
            key={laid.entry.id}
            laid={laid}
            cursor={cursor === laid.entry.id}
            onScreen={onScreen === laid.entry.session.sessionId}
            now={now}
            leaving={!!leaving[laid.entry.id]}
            actions={actions}
        />
    );
    return (
        <section className="errand-shelf" data-testid="errand-shelf" aria-label="Errands">
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
                <span className="errand-shelf-label">Errands</span>
                <span className="errand-shelf-count">{errands.length}</span>
                <span className={'errand-shelf-summary' + (summary.needsYou ? ' is-needs-you' : '')}>
                    <span className="errand-shelf-dot" aria-hidden="true" />
                    {summary.text}
                </span>
            </button>
            <div className="errand-shelf-scroll">
                {stuck.map(row)}
                {rest.length > 0 && (
                    <div
                        className={'errand-shelf-body' + (open ? '' : ' is-folded')}
                        id="errand-shelf-body"
                        inert={!open}>
                        <div className="errand-shelf-rows">
                            {rest.map((laid, i) => (
                                <div
                                    key={laid.entry.id}
                                    className="errand-shelf-entry"
                                    style={{'--i': i, '--n': rest.length} as CSSProperties}>
                                    {row(laid)}
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
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
 * One errand on one line: its kind, `#431 · fixing checks`, and where it runs
 * and how long ago it started, which give way to PR ↗, Stop and archive on
 * hover. A click anywhere else opens its session, as a sidebar row's does.
 * The archive button is the one the keyboard's `e` presses
 * (`.session-archive-btn`). Renaming is not offered: the name is the errand's.
 */
function ErrandRow({laid, cursor, onScreen, now, leaving, actions}: ErrandRowProps): JSX.Element {
    const {entry, errand} = laid;
    const {sessionId} = entry.session;
    const name = errandRowName(errand);
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
            <span className="errand-row-meta">
                {errandPlace(errand)} · {formatDate(new Date(entry.session.created), now)}
            </span>
            <span className="errand-row-actions">
                <button
                    type="button"
                    className="errand-row-btn"
                    title={`Open #${errand.number} in the browser`}
                    onClick={button(() => actions.openPullRequest(errandPullRequestUrl(errand)))}>
                    PR ↗
                </button>
                <button
                    type="button"
                    className="errand-row-btn is-stop"
                    title="Stop"
                    onClick={button(() => actions.stop(sessionId))}>
                    Stop
                </button>
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

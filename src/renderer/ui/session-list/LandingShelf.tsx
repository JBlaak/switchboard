/**
 * The Landing shelf: the user's landed pull requests as one line under the
 * session list, so how long each still waits to merge is always in sight.
 *
 * Rendered into `#sidebar-landing`, under the Automatic shelf and above the
 * footer. Folded, it is one line: a count, a dot per PR in each lane (the
 * user's filled, other people's in a queue lane hollow, lanes apart) and when
 * the next one merges. Clicked, it unfolds into a row per PR, which opens the
 * PR's session (or its fix errand), what merged today, which opens it in the
 * Merge manager, and a link to the Merge manager's page.
 *
 * The colours are every place's (`stageTone`): purple merging or merged,
 * green ready, yellow in progress or needs you, grey held, red an error.
 * When one of the user's PRs merges, the Land it rocket takes off from its
 * dot, and the line says "✓ #n" for a moment before the next time rolls in.
 *
 * Hidden while nothing is landed and nothing merged in the last minutes.
 */
import {useEffect, useMemo, useRef, useState} from 'react';
import {JUST_MERGED_MS, etaText, landingStrip, mergedAgo, stillText} from '../../../domain/merge-manager/landing';
import {launchRocket} from '../../lib/motion/rocket';
import {shallowEqual} from '../../state/store';
import {useStore} from '../use-store';
import {openMergeManager, openRowSession} from '../merge-manager/page-actions';
import {toggleLandingShelf} from './actions';
import {TimedBar} from '../merge-manager/TimedBar';
import type {JSX} from 'react';
import type {LandingLane, LandingPip, LandingRow, LandingStrip} from '../../../domain/merge-manager/landing';
import type {LandedView, MergeManagerState} from '../../../domain/merge-manager/model';

/** A merge older than this when it is first seen (the app just started, say) launches nothing. */
const ROCKET_FRESH_MS = 60_000;

export function LandingShelf(): JSX.Element | null {
    const {state, ticked, open} = useStore(
        (s) => ({state: s.mergeManager.state, ticked: s.sessionList.now, open: s.sessionList.landingShelfOpen}),
        shallowEqual,
    );
    // The list's clock ticks every 30s; a merge has to show the moment it is pushed, and leave on time.
    const [clock, setClock] = useState(Date.now);
    useEffect(() => setClock(Date.now()), [state]);
    const now = Math.max(ticked, clock);
    const strip = useMemo(() => landingStrip(state, now), [state, now]);
    const leavesAt = strip.justMerged?.stage.kind === 'merged' ? strip.justMerged.stage.at + JUST_MERGED_MS : null;
    useEffect(() => {
        if (leavesAt === null) return;
        const timer = setTimeout(() => setClock(Date.now()), Math.max(0, leavesAt - Date.now()) + 50);
        return () => clearTimeout(timer);
    }, [leavesAt]);
    useRocketOnMerge(state);
    return <LandingShelfView strip={strip} open={open} now={now} actions={LANDING_ACTIONS} />;
}

/** What the shelf's controls do; the view takes them so it draws without the store. */
export interface LandingShelfActions {
    toggle(): void;
    /** A Just merged row: the PR on the Merge manager's page. */
    show(key: string): void;
    /** A shelf row: its session, or its fix errand's. */
    open(row: LandingRow): void;
    /** The unfolded rows' link: the Merge manager's page. */
    manager(): void;
}

const LANDING_ACTIONS: LandingShelfActions = {
    toggle: toggleLandingShelf,
    show: (key) => openMergeManager(key),
    open: (row) => void openRowSession(row.row),
    manager: () => openMergeManager(),
};

export interface LandingShelfViewProps {
    strip: LandingStrip;
    open: boolean;
    now: number;
    actions: LandingShelfActions;
}

export function LandingShelfView({strip, open, now, actions}: LandingShelfViewProps): JSX.Element | null {
    if (!strip.visible) return null;
    const slot = slotOf(strip);
    return (
        <section
            className={'landing-shelf' + (open ? '' : ' is-folded')}
            data-testid="landing-shelf"
            aria-label="Landing">
            <button
                type="button"
                className="landing-shelf-header"
                aria-expanded={open}
                aria-controls="landing-shelf-body"
                aria-label={headerLabel(strip, slot.text)}
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
                <span className="landing-shelf-label">Landing</span>
                {strip.count > 0 && (
                    <span className="landing-shelf-count">
                        <span key={strip.count} className="landing-roll">
                            {strip.count}
                        </span>
                    </span>
                )}
                <span className="landing-pips" aria-hidden="true">
                    {strip.lanes.map((lane) => (
                        <span key={lane.repository} className="landing-pip-lane">
                            {lane.pips.map((pip) => (
                                <Pip key={pip.key} pip={pip} />
                            ))}
                        </span>
                    ))}
                </span>
                {strip.needsYou > 0 && (
                    <span className="landing-badge" title={`${strip.needsYou} need you`}>
                        {strip.needsYou}
                    </span>
                )}
                <span className="landing-sep" aria-hidden="true" />
                <span className="landing-eta" data-tone={slot.tone} data-testid="landing-eta">
                    <span key={slot.text} className="landing-roll">
                        {slot.text}
                    </span>
                </span>
            </button>
            <div className={'landing-shelf-body' + (open ? '' : ' is-folded')} id="landing-shelf-body" inert={!open}>
                <div className="landing-shelf-rows">
                    <Lanes strip={strip} onRow={actions.open} />
                    <Merged strip={strip} now={now} onRow={(pr) => actions.show(pr.key)} />
                    <ManagerLink onClick={actions.manager} />
                </div>
            </div>
        </section>
    );
}

function Pip({pip}: {pip: LandingPip}): JSX.Element {
    return (
        <span
            className={
                'landing-pip' +
                (pip.own ? '' : ' is-other') +
                (pip.head ? ' is-head' : '') +
                (pip.fixing ? ' is-fixing' : '') +
                (pip.gone ? ' is-gone' : '')
            }
            data-tone={pip.tone}
            data-pip-key={pip.key}
        />
    );
}

function Lanes({strip, onRow}: {strip: LandingStrip; onRow: (row: LandingRow) => void}): JSX.Element {
    return (
        <>
            {strip.lanes
                .filter((lane) => lane.rows.length > 0)
                .map((lane) => (
                    <div key={lane.repository} className="landing-lane">
                        <div className="landing-lane-name">
                            {lane.repository}
                            <span>{laneMeta(lane)}</span>
                        </div>
                        {lane.rows.map((row) => (
                            <button
                                key={row.key}
                                type="button"
                                className="landing-row"
                                data-tone={row.tone}
                                onClick={() => onRow(row)}>
                                <span
                                    className={
                                        'landing-pip' +
                                        (row.row.stage.kind === 'head' ? ' is-head' : '') +
                                        (row.row.stage.kind === 'fixing' ? ' is-fixing' : '')
                                    }
                                    data-tone={row.tone}
                                    aria-hidden="true"
                                />
                                <span className="landing-row-text">
                                    <span className="landing-row-title">
                                        {row.title} <span className="landing-row-number">#{row.number}</span>
                                    </span>
                                    <span className="landing-row-stage">{row.label}</span>
                                    {row.timing !== null && (
                                        <TimedBar
                                            className="landing-bar"
                                            timing={row.timing}
                                            seenKey={`${row.key}|${row.row.stage.kind === 'head' ? row.row.stage.step : ''}`}
                                        />
                                    )}
                                </span>
                                <span className="landing-row-eta">{row.eta ? etaText(row.eta) : '—'}</span>
                            </button>
                        ))}
                    </div>
                ))}
        </>
    );
}

function Merged({
    strip,
    now,
    onRow,
}: {
    strip: LandingStrip;
    now: number;
    onRow: (pr: LandedView) => void;
}): JSX.Element | null {
    if (strip.merged.length === 0) return null;
    return (
        <div className="landing-lane is-merged">
            <div className="landing-lane-name">Just merged</div>
            {strip.merged.map((pr) => (
                <button
                    key={pr.key}
                    type="button"
                    className={'landing-row is-merged' + (strip.justMerged?.key === pr.key ? ' is-fresh' : '')}
                    data-tone="merging"
                    onClick={() => onRow(pr)}>
                    <RocketGlyph />
                    <span className="landing-row-text">
                        <span className="landing-row-title">
                            {pr.title} <span className="landing-row-number">#{pr.number}</span>
                        </span>
                    </span>
                    <span className="landing-row-ago">{mergedAgo(pr, now)}</span>
                </button>
            ))}
        </div>
    );
}

/** The way to the Merge manager's page, under the unfolded shelf's rows. */
function ManagerLink({onClick}: {onClick: () => void}): JSX.Element {
    return (
        <button type="button" className="landing-manager-link" onClick={onClick}>
            Open Merge manager
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                    d="M3 2l4 3-4 3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </button>
    );
}

/** The Land it rocket, small: what merged. */
function RocketGlyph(): JSX.Element {
    return (
        <svg className="landing-rocket" width="9" height="14" viewBox="0 0 34 54" fill="none" aria-hidden="true">
            <path d="M17 2 C 27 12, 28 28, 25 38 H9 C 6 28, 7 12, 17 2 Z" fill="currentColor" />
            <path d="M9 30 L2 42 L9 40 Z M25 30 L32 42 L25 40 Z" fill="currentColor" />
            <path d="M11 38 Q17 54 23 38 Z" fill="#f39a3c" />
        </svg>
    );
}

/** The line's right edge: what just merged, else the next time, else why nothing counts down. */
function slotOf(strip: LandingStrip): {text: string; tone: string} {
    if (strip.justMerged) return {text: '✓ #' + strip.justMerged.number, tone: 'merging'};
    const next = strip.next;
    if (next?.eta) {
        const tone = next.row.stage.kind === 'head' ? 'merging' : next.eta.approximate ? 'progress' : 'ready';
        return {text: etaText(next.eta), tone};
    }
    return stillText(strip);
}

function headerLabel(strip: LandingStrip, slot: string): string {
    const count = strip.count === 1 ? '1 pull request' : `${strip.count} pull requests`;
    const next = strip.justMerged
        ? `#${strip.justMerged.number} just merged`
        : strip.next?.eta
          ? `#${strip.next.number} merges in about ${etaText(strip.next.eta)}`
          : slot;
    return `Landing: ${count}, ${next}`;
}

function laneMeta(lane: LandingLane): string {
    const kind = lane.kind === 'switchboard' ? 'Switchboard lane' : 'queue lane';
    const inLine = lane.pips.filter((pip) => !pip.gone).length;
    return `${kind} · ${inLine} in line`;
}

/**
 * The rocket, when one of the user's PRs merges while the app watches: from
 * its dot as it leaves, else from the line's time. A merge already known when
 * the shelf first saw the lanes, or older than a minute, launches nothing.
 */
function useRocketOnMerge(state: MergeManagerState): void {
    const known = useRef<Set<string> | null>(null);
    useEffect(() => {
        const merged = state.lanes.flatMap((lane) => lane.pullRequests).filter((pr) => pr.stage.kind === 'merged');
        const seen = known.current;
        known.current = new Set(merged.map((pr) => pr.key));
        if (!seen) return;
        const now = Date.now();
        for (const pr of merged) {
            if (seen.has(pr.key) || pr.stage.kind !== 'merged' || now - pr.stage.at > ROCKET_FRESH_MS) continue;
            const from =
                document.querySelector(`[data-pip-key="${CSS.escape(pr.key)}"]`) ??
                document.querySelector('[data-testid="landing-eta"]');
            if (!from) continue;
            const box = from.getBoundingClientRect();
            launchRocket(box.left + box.width / 2, box.top + box.height / 2);
        }
    }, [state]);
}

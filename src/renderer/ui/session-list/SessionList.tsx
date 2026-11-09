/**
 * The session list: one flat list across every project, in sections, with the
 * rows that are too old folded behind "+ N older", and the space under it.
 *
 * Rendered into `#sidebar-content`, which stays the scrolling container — so
 * the scroll position is never touched by a redraw — and stays the element
 * the keyboard navigation focuses and listens on.
 *
 * What is laid out where comes from the last redraw (`sessionList.layout`);
 * see `session-list-slice` for why the order is not recomputed on every
 * render.
 */
import {useEffect, useLayoutEffect, useRef} from 'react';
import {TIER_LABELS, TIER_PINNED_PLAN, isFoldableTier} from '../../../domain/session/tiers';
import {sectionTarget} from '../../state/list-cursor';
import {sidebarContent} from '../../lib/dom';
import {useStore} from '../use-store';
import {clearScreenFromList, toggleOlder, toggleSection} from './actions';
import {installDragSpace} from './drag-space';
import {installPinDrag} from './pin-drag';
import {restoreTerminalFocus} from './focus';
import {PinnedPlanItem} from './PinnedPlanItem';
import {PinnedProjectItem} from './PinnedProjectItem';
import {SessionItem} from './SessionItem';
import {SlugGroup} from './SlugGroup';
import {useReflow} from './use-reflow';
import type {CSSProperties, JSX} from 'react';
import type {LaidEntry} from '../../state/session-list-layout';

export function SessionList(): JSX.Element | null {
    const layout = useStore((s) => s.sessionList.layout);
    const revision = useStore((s) => s.sessionList.revision);
    const olderExpanded = useStore((s) => s.sessionList.olderExpanded);
    const olderCursor = useStore((s) => s.sessionList.cursor === 'older-all');

    useReflow(sidebarContent, revision);

    // After each redraw the terminal gets the keyboard back (see `restoreTerminalFocus`).
    useLayoutEffect(() => {
        if (revision > 0) restoreTerminalFocus();
    }, [revision]);

    // The empty space is the container's own, padding included, so the click is
    // heard there rather than on anything this tree renders.
    useEffect(() => {
        const onClick = (e: MouseEvent): void => clearScreenFromList(e.target as Element);
        sidebarContent.addEventListener('click', onClick);
        return () => sidebarContent.removeEventListener('click', onClick);
    }, []);

    // The blank space below the list also drags the window. It only renders once
    // there is a layout, so that is when it is watched.
    const dragSpace = useRef<HTMLDivElement>(null);
    useEffect(() => (dragSpace.current ? installDragSpace(dragSpace.current) : undefined), [layout !== null]);

    // Pinned entries drag into their own order (#379); one listener serves them all.
    useEffect(() => installPinDrag(sidebarContent), []);

    const noProjects = useStore((s) => s.toolbar.hasProjects === false);

    if (!layout) return noProjects ? <FirstRunHint /> : null;
    const {visible, older, filtering} = layout;

    return (
        <>
            <div className="session-list" id="session-list">
                {noProjects && <FirstRunHint />}
                {sections(visible, filtering)}
                {older.length > 0 && (
                    <>
                        <div
                            className={
                                'sessions-more-toggle' +
                                (olderExpanded ? ' expanded' : '') +
                                (olderCursor ? ' kbd-cursor' : '')
                            }
                            id="older-all"
                            onClick={toggleOlder}>
                            {olderExpanded ? '- hide older' : `+ ${older.length} older`}
                        </div>
                        <div
                            className="sessions-older"
                            id="older-list-all"
                            style={olderExpanded ? undefined : {display: 'none'}}>
                            {older.map((laid) => (
                                <Entry key={laid.entry.id} laid={laid} />
                            ))}
                        </div>
                    </>
                )}
            </div>
            {/* Fills whatever height the list leaves free: a click there puts the session away, a drag moves the window. */}
            <div id="sidebar-drag-space" data-testid="sidebar-drag-space" ref={dragSpace} />
        </>
    );
}

/**
 * The entries with a label at the head of each section. Section labels only
 * make sense in the unfiltered view; a filtered list is already one answer to
 * one question.
 *
 * Pinned projects and Pinned plans fold under their label: their entries sit
 * in a body that eases shut, so they never leave the DOM and come back.
 */
function sections(visible: readonly LaidEntry[], filtering: boolean): JSX.Element[] {
    if (filtering) return visible.map((laid) => <Entry key={laid.entry.id} laid={laid} />);
    const out: JSX.Element[] = [];
    for (const run of tierRuns(visible)) {
        if (isFoldableTier(run.tier)) {
            out.push(<FoldableSection key={'section-' + run.tier} tier={run.tier} entries={run.entries} />);
            continue;
        }
        out.push(
            <div key={'section-' + run.tier} className="session-section-label" id={sectionTarget(run.tier)}>
                {TIER_LABELS[run.tier]}
            </div>,
        );
        for (const laid of run.entries) out.push(<Entry key={laid.entry.id} laid={laid} />);
    }
    return out;
}

/** The visible entries cut where the tier changes. */
function tierRuns(visible: readonly LaidEntry[]): {tier: number; entries: LaidEntry[]}[] {
    const runs: {tier: number; entries: LaidEntry[]}[] = [];
    for (const laid of visible) {
        const last = runs[runs.length - 1];
        if (last && last.tier === laid.tier) last.entries.push(laid);
        else runs.push({tier: laid.tier, entries: [laid]});
    }
    return runs;
}

/**
 * A pinned section: its label is a button with a chevron that folds the
 * entries away, and once folded it says how many it holds.
 */
function FoldableSection({tier, entries}: {tier: number; entries: readonly LaidEntry[]}): JSX.Element {
    const folded = useStore((s) => s.sessionList.foldedSections.includes(tier));
    const cursor = useStore((s) => s.sessionList.cursor === sectionTarget(tier));
    const id = sectionTarget(tier);
    return (
        <>
            <button
                type="button"
                className={
                    'session-section-label is-foldable' + (folded ? ' is-folded' : '') + (cursor ? ' kbd-cursor' : '')
                }
                id={id}
                aria-expanded={!folded}
                aria-controls={id + '-body'}
                onClick={() => toggleSection(tier)}>
                <span className="session-section-chevron" aria-hidden="true" dangerouslySetInnerHTML={CHEVRON} />
                {TIER_LABELS[tier]}
                {folded && <span className="session-section-count">{entries.length}</span>}
            </button>
            <div className={'session-section-body' + (folded ? ' is-folded' : '')} id={id + '-body'} inert={folded}>
                <div className="session-section-rows">
                    {entries.map((laid, i) => (
                        <div
                            key={laid.entry.id}
                            className="session-section-entry"
                            style={{'--i': i, '--n': entries.length} as CSSProperties}>
                            <Entry laid={laid} />
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}

const CHEVRON = {
    __html: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 2l4 3-4 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** With no project at all, where to start: the Projects button above, which carries a dot (#171). */
function FirstRunHint(): JSX.Element {
    return (
        <p className="session-list-first-run">
            No sessions yet. Add a project with the Projects button above, or press <kbd className="sw-kbd">⌘A</kbd>.
        </p>
    );
}

function Entry({laid}: {laid: LaidEntry}): JSX.Element {
    switch (laid.entry.kind) {
        case 'group':
            return <SlugGroup group={laid.entry} pinned={laid.tier === TIER_PINNED_PLAN} />;
        case 'plan':
            return <PinnedPlanItem plan={laid.entry} />;
        case 'project':
            return <PinnedProjectItem project={laid.entry} />;
        default:
            return <SessionItem row={laid.entry} />;
    }
}

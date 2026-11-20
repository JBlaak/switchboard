/**
 * The Merge manager's page by status (`statusGroups`): a chip per group with
 * anything in it, and each group under its tone dot, name, count and blurb.
 *
 * A prominent group draws each PR as a card: its number and title, its pill,
 * what kind it is ("Landed · queue lane · head", "Not landed"), its actions,
 * its whole timeline and what is happening now. The others draw compact rows
 * in one panel: the title with the now sentence under it, a mini timeline,
 * the pill with when it merges, and the actions. Drafts starts folded.
 *
 * A click on a card or row selects it and opens its side view (`onSelect`);
 * its buttons do their own thing and leave the selection be.
 */
import type {JSX, MouseEvent} from 'react';
import {rowActions, type PageLane, type PageRow} from '../../../domain/merge-manager/page';
import {canLand, notLandedStatus} from '../../../domain/merge-manager/not-landed';
import {untilText, type RowTime} from '../../../domain/merge-manager/times';
import type {PrTimeline} from '../../../domain/merge-manager/pr-timeline';
import type {StatusGroup, StatusGroupId, StatusItem} from '../../../domain/merge-manager/status';
import type {LandAction} from '../../state/merge-manager-slice';
import {NotLandedLandIt, NotLandedPill} from './NotLandedRow';
import {PrTimelineView} from './PrTimelineView';
import {StagePill} from './StagePill';
import {expectedClock, itemKind} from './status-view';
import {nudgeFromPage, openRowOnGitHub, openRowSession, tryAgainFromPage, unlandFromPage} from './page-actions';

/** What a group's items need besides themselves: their timelines and expected merges, the selection and the lands under way. */
export interface ItemContext {
    readonly lanes: readonly PageLane[];
    readonly timelineOf: (item: StatusItem) => PrTimeline;
    readonly timeOf: (item: StatusItem) => RowTime | undefined;
    readonly selected: string | null;
    readonly busy: Readonly<Record<string, LandAction>>;
    readonly onSelect: (key: string) => void;
}

/** A chip per group: its name and count, the prominent ones larger and in their tone. */
export function StatusChips({
    groups,
    onGo,
}: {
    groups: readonly StatusGroup[];
    onGo: (id: StatusGroupId) => void;
}): JSX.Element | null {
    if (groups.length === 0) return null;
    return (
        <nav className="mm-chips" aria-label="Groups">
            {groups.map((group) => (
                <button
                    key={group.id}
                    type="button"
                    className={'mm-chip is-tone-' + group.tone + (group.prominent ? ' is-prominent' : '')}
                    onClick={() => onGo(group.id)}>
                    <i aria-hidden="true" />
                    {group.name}
                    <b>{group.items.length}</b>
                </button>
            ))}
        </nav>
    );
}

export function StatusGroupSection({
    group,
    open,
    onFold,
    context,
}: {
    group: StatusGroup;
    /** Its items show: always, but for a folded group once unfolded. */
    open: boolean;
    /** Show or Hide, for a group that starts folded. */
    onFold: () => void;
    context: ItemContext;
}): JSX.Element {
    const count = group.items.length;
    return (
        <section
            className={'mm-group is-tone-' + group.tone + (group.prominent ? ' is-prominent' : '')}
            role="group"
            aria-label={group.name}
            data-group={group.id}>
            <div className="mm-group-head">
                <i aria-hidden="true" />
                <h2>{group.name}</h2>
                <span className="mm-group-count">{count}</span>
                <span className="mm-group-blurb">{group.blurb}</span>
                {group.folded && (
                    <button type="button" className="sw-btn sw-btn-small mm-group-fold" onClick={onFold}>
                        {open ? 'Hide' : `Show ${count}`}
                    </button>
                )}
            </div>
            {open &&
                (group.prominent ? (
                    <div className="mm-group-cards">
                        {group.items.map((item) => (
                            <StatusCard key={item.key} item={item} group={group} context={context} />
                        ))}
                    </div>
                ) : (
                    <div className="mm-card mm-group-rows">
                        {group.items.map((item) => (
                            <StatusRow key={item.key} item={item} group={group} context={context} />
                        ))}
                    </div>
                ))}
        </section>
    );
}

function StatusCard({item, group, context}: {item: StatusItem; group: StatusGroup; context: ItemContext}): JSX.Element {
    const timeline = context.timelineOf(item);
    const time = context.timeOf(item);
    const selected = context.selected === item.key;
    const {number, title} = item.kind === 'lane' ? item.row : item.pr;
    return (
        <div
            role="option"
            aria-selected={selected}
            data-merge-key={item.key}
            className={'mm-sc' + (selected ? ' is-selected' : '')}
            onClick={() => context.onSelect(item.key)}>
            <div className="mm-sc-top">
                <span className="mm-sc-title">
                    <span className="mm-row-number">#{number}</span> {title}
                </span>
                <Pill item={item} />
                <span className="mm-sc-kind">{itemKind(item, context.lanes)}</span>
                <span className="mm-sc-gap" />
                {time && (
                    <span className={'mm-sc-eta' + (time.rough ? ' is-rough' : '')}>
                        <b>{expectedClock(time)}</b> {untilText(time)}
                    </span>
                )}
                <Actions item={item} busy={context.busy[item.key] === 'land'} />
            </div>
            <PrTimelineView timeline={timeline} tone={group.tone} seenKey={item.key} />
            <p className="mm-sc-now">
                <b>Now</b> {timeline.now}
            </p>
        </div>
    );
}

function StatusRow({item, group, context}: {item: StatusItem; group: StatusGroup; context: ItemContext}): JSX.Element {
    const timeline = context.timelineOf(item);
    const time = context.timeOf(item);
    const selected = context.selected === item.key;
    const {number, title} = item.kind === 'lane' ? item.row : item.pr;
    const draft = item.kind === 'notLanded' && item.pr.isDraft;
    return (
        <div
            role="option"
            aria-selected={selected}
            data-merge-key={item.key}
            className={'mm-sr' + (selected ? ' is-selected' : '') + (draft ? ' is-draft' : '')}
            onClick={() => context.onSelect(item.key)}>
            <span className="mm-row-text">
                <span className="mm-row-title">
                    <span className="mm-row-number">#{number}</span> {title}
                </span>
                <span className="mm-row-meta">{timeline.now}</span>
            </span>
            <PrTimelineView timeline={timeline} tone={group.tone} seenKey={item.key} compact />
            <span className="mm-sr-status">
                <Pill item={item} />
                {time && (
                    <span className={'mm-sr-eta' + (time.rough ? ' is-rough' : '')} title={untilText(time)}>
                        {expectedClock(time)}
                    </span>
                )}
            </span>
            <Actions item={item} busy={context.busy[item.key] === 'land'} compact />
        </div>
    );
}

function Pill({item}: {item: StatusItem}): JSX.Element {
    return item.kind === 'lane' ? <StagePill row={item.row} /> : <NotLandedPill status={notLandedStatus(item.pr)} />;
}

/** A button on a card or row: does its thing without selecting it. */
function Act({
    label,
    letter,
    compact,
    ghost,
    onClick,
}: {
    label: string;
    letter: string;
    compact: boolean;
    ghost?: boolean;
    onClick: () => void;
}): JSX.Element {
    return (
        <button
            type="button"
            className={'sw-btn sw-btn-small' + (ghost ? ' is-ghost' : '')}
            title={compact ? `${label} (${letter})` : undefined}
            onClick={(e: MouseEvent) => {
                e.stopPropagation();
                onClick();
            }}>
            {label}
            {!compact && <kbd className="sw-kbd">{letter}</kbd>}
        </button>
    );
}

function Actions({item, busy, compact = false}: {item: StatusItem; busy: boolean; compact?: boolean}): JSX.Element {
    if (item.kind === 'notLanded') {
        const {pr} = item;
        return (
            <span className="mm-acts">
                {canLand(pr) && <NotLandedLandIt pr={pr} primary={notLandedStatus(pr) === 'ready'} busy={busy} />}
                <Act label="GitHub" letter="O" compact={compact} ghost onClick={() => openRowOnGitHub(pr)} />
            </span>
        );
    }
    return <LandedActions row={item.row} compact={compact} />;
}

function LandedActions({row, compact}: {row: PageRow; compact: boolean}): JSX.Element {
    const offers = rowActions(row);
    return (
        <span className="mm-acts">
            <Act
                label={offers.open.kind === 'errand' ? 'Open errand' : 'Open session'}
                letter="↵"
                compact={compact}
                onClick={() => void openRowSession(row)}
            />
            {offers.tryAgain && (
                <Act label="Try again" letter="T" compact={compact} onClick={() => void tryAgainFromPage(row)} />
            )}
            {offers.nudge && (
                <Act
                    label={`Nudge ${offers.nudge}`}
                    letter="N"
                    compact={compact}
                    onClick={() => void nudgeFromPage(row)}
                />
            )}
            {offers.unland && (
                <Act label="Unland" letter="U" compact={compact} ghost onClick={() => void unlandFromPage(row)} />
            )}
            <Act label="GitHub" letter="O" compact={compact} ghost onClick={() => openRowOnGitHub(row)} />
        </span>
    );
}

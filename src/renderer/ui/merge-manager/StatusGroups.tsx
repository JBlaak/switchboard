/**
 * The Merge manager's page by status (`statusGroups`): a chip per group with
 * anything in it, and each group under its tone dot, name, count and blurb.
 *
 * A prominent group draws each PR as a card: its repository's mark and name,
 * its number and title, its pill and when it merges on one line; its whole
 * timeline; then what is happening now, what kind it is ("Landed · queue lane
 * · head", "Not landed") and its actions. The others draw compact rows in one
 * panel, under a header per repository (its mark, name and lane): the title
 * with the now sentence under it, the pill, when it merges, and one button
 * with GitHub beside it; the rest of a row's actions are in its side view.
 * Cards share their columns, and so do rows, so they line up down the page.
 * Drafts starts folded.
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
import {RepoMark} from '../shared/RepoMark';
import {byRepository, expectedClock, itemKind, repositoryName} from './status-view';
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
                        {byRepository(group.items, context.lanes).map((repo) => (
                            <div key={repo.repository} role="group" aria-label={repo.name} className="mm-repo">
                                <div className="mm-repo-head" title={repo.repository}>
                                    <RepoMark name={repo.repository} />
                                    <span className="mm-repo-name">{repo.name}</span>
                                    {repo.lane && <span className="mm-repo-lane">{repo.lane}</span>}
                                </div>
                                {repo.items.map((item) => (
                                    <StatusRow key={item.key} item={item} group={group} context={context} />
                                ))}
                            </div>
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
    const {number, title, repository} = item.kind === 'lane' ? item.row : item.pr;
    return (
        <div
            role="option"
            aria-selected={selected}
            data-merge-key={item.key}
            className={'mm-sc' + (selected ? ' is-selected' : '')}
            onClick={() => context.onSelect(item.key)}>
            <div className="mm-sc-top">
                <span className="mm-sc-repo" title={repository}>
                    <RepoMark name={repository} />
                    <span>{repositoryName(repository)}</span>
                </span>
                <span className="mm-sc-title">
                    <span className="mm-row-number">#{number}</span> {title}
                </span>
                <span className="mm-sc-pill">
                    <Pill item={item} />
                </span>
                <span className={'mm-sc-eta' + (time?.rough ? ' is-rough' : '')}>
                    {time && (
                        <>
                            <b>{expectedClock(time)}</b> {untilText(time)}
                        </>
                    )}
                </span>
            </div>
            <PrTimelineView timeline={timeline} tone={group.tone} seenKey={item.key} />
            <div className="mm-sc-foot">
                <p className="mm-sc-now">
                    <b>Now</b> {timeline.now}
                </p>
                <span className="mm-sc-kind">{itemKind(item, context.lanes)}</span>
                <Actions item={item} busy={context.busy[item.key] === 'land'} />
            </div>
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
            data-tone={group.tone}
            className={'mm-sr' + (selected ? ' is-selected' : '') + (draft ? ' is-draft' : '')}
            onClick={() => context.onSelect(item.key)}>
            <span className="mm-row-text">
                <span className="mm-row-title">
                    <span className="mm-row-number">#{number}</span> {title}
                </span>
                <span className="mm-row-meta">{timeline.now}</span>
            </span>
            <span className="mm-sr-pill">
                <Pill item={item} />
            </span>
            <span className={'mm-sr-eta' + (time?.rough ? ' is-rough' : '')} title={time ? untilText(time) : undefined}>
                {time ? expectedClock(time) : ''}
            </span>
            <RowActions item={item} busy={context.busy[item.key] === 'land'} />
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
    compact = false,
    ghost,
    onClick,
}: {
    label: string;
    letter: string;
    /** A row's: the key in its tooltip, not beside it. */
    compact?: boolean;
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

function Actions({item, busy}: {item: StatusItem; busy: boolean}): JSX.Element {
    if (item.kind === 'notLanded') {
        const {pr} = item;
        return (
            <span className="mm-acts">
                {canLand(pr) && <NotLandedLandIt pr={pr} primary={notLandedStatus(pr) === 'ready'} busy={busy} />}
                <Act label="GitHub" letter="O" ghost onClick={() => openRowOnGitHub(pr)} />
            </span>
        );
    }
    return <LandedActions row={item.row} />;
}

/** A compact row's actions: its one main button, and GitHub as an icon; the rest are in its side view. */
function RowActions({item, busy}: {item: StatusItem; busy: boolean}): JSX.Element {
    const github = item.kind === 'lane' ? item.row : item.pr;
    let main: JSX.Element | null = null;
    if (item.kind === 'notLanded') {
        if (canLand(item.pr))
            main = <NotLandedLandIt pr={item.pr} primary={notLandedStatus(item.pr) === 'ready'} busy={busy} />;
    } else {
        const {row} = item;
        const open = rowActions(row).open.kind === 'errand' ? 'Open errand' : 'Open session';
        main = <Act label={open} letter="↵" compact onClick={() => void openRowSession(row)} />;
    }
    return (
        <span className="mm-acts mm-sr-acts">
            {main}
            <button
                type="button"
                className="sw-btn sw-btn-small is-ghost mm-sr-github"
                aria-label="Open on GitHub"
                title="Open on GitHub (O)"
                onClick={(e: MouseEvent) => {
                    e.stopPropagation();
                    openRowOnGitHub(github);
                }}>
                <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true">
                    <path d="M14 3h7v7M10 14 21 3M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                </svg>
            </button>
        </span>
    );
}

function LandedActions({row}: {row: PageRow}): JSX.Element {
    const offers = rowActions(row);
    return (
        <span className="mm-acts">
            <Act
                label={offers.open.kind === 'errand' ? 'Open errand' : 'Open session'}
                letter="↵"

                onClick={() => void openRowSession(row)}
            />
            {offers.tryAgain && <Act label="Try again" letter="T" onClick={() => void tryAgainFromPage(row)} />}
            {offers.nudge && (
                <Act
                    label={`Nudge ${offers.nudge}`}
                    letter="N"

                    onClick={() => void nudgeFromPage(row)}
                />
            )}
            {offers.unland && <Act label="Unland" letter="U" ghost onClick={() => void unlandFromPage(row)} />}
            <Act label="GitHub" letter="O" ghost onClick={() => openRowOnGitHub(row)} />
        </span>
    );
}

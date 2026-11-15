/**
 * A Not landed row, the same in the Merge manager's section and on its Not
 * landed page: a hollow place (it has none yet), `#number title` with its
 * repository, branch, age and why under it, what stands between it and
 * landing as a pill, and Land it (primary once it is ready; none for a
 * draft, whose title is dimmer). A click selects the row and opens its side
 * view; Land it does not, and launches the rocket from itself.
 */
import type {JSX} from 'react';
import {
    canLand,
    notLandedKey,
    notLandedLabel,
    notLandedMeta,
    notLandedStatus,
    notLandedTone,
    type NotLandedStatus,
    type OpenPullRequest,
} from '../../../domain/merge-manager/not-landed';
import {landNotLanded} from './not-landed-actions';

export function NotLandedRow({
    pr,
    now,
    selected,
    busy,
    onSelect,
}: {
    pr: OpenPullRequest;
    now: number;
    selected: boolean;
    /** A land is under way for it. */
    busy: boolean;
    onSelect: (key: string) => void;
}): JSX.Element {
    const key = notLandedKey(pr);
    const status = notLandedStatus(pr);
    return (
        <div
            role="option"
            aria-selected={selected}
            data-merge-key={key}
            className={'mm-row mm-nl-row' + (selected ? ' is-selected' : '') + (pr.isDraft ? ' is-draft' : '')}
            onClick={() => onSelect(key)}>
            <span className="mm-place is-open" aria-hidden="true" />
            <span className="mm-row-text">
                <span className="mm-row-title">
                    <span className="mm-row-number">#{pr.number}</span> {pr.title}
                </span>
                <span className="mm-row-meta">{notLandedMeta(pr, now)}</span>
            </span>
            <NotLandedPill status={status} />
            <span className="mm-nl-act">
                {canLand(pr) && <NotLandedLandIt pr={pr} primary={status === 'ready'} busy={busy} />}
            </span>
        </div>
    );
}

/** What stands between it and landing, in its tone. */
export function NotLandedPill({status}: {status: NotLandedStatus}): JSX.Element {
    return (
        <span className={'pp-stage mm-nl-pill is-nl-' + notLandedTone(status)}>
            <i aria-hidden="true" />
            {notLandedLabel(status)}
        </span>
    );
}

/**
 * Land it on a Not landed PR: waits while a land is under way, never toggles
 * its row, and launches the rocket from itself (`data-land-key` lets L find it).
 */
export function NotLandedLandIt({
    pr,
    primary,
    busy,
    shortcut = false,
}: {
    pr: OpenPullRequest;
    primary: boolean;
    busy: boolean;
    shortcut?: boolean;
}): JSX.Element {
    return (
        <button
            type="button"
            className={'sw-btn mm-nl-land' + (primary ? ' is-ready' : '')}
            data-land-key={notLandedKey(pr)}
            disabled={busy}
            aria-busy={busy}
            onClick={(e) => {
                e.stopPropagation();
                void landNotLanded(pr, e.currentTarget);
            }}>
            {busy ? 'Landing…' : 'Land it'}
            {shortcut && <kbd className="sw-kbd">L</kbd>}
        </button>
    );
}

/**
 * Not landed on the Merge manager's page: a card after the lanes and before
 * Merged today with your newest five open PRs that are not in a lane, newest
 * first, and View all (the Not landed page) when there are more. Left out
 * when there are none (`notLandedSection`).
 */
import type {JSX} from 'react';
import {notLandedKey} from '../../../domain/merge-manager/not-landed';
import {NotLandedRow} from './NotLandedRow';
import {openNotLandedPage} from './not-landed-actions';
import type {LandAction} from '../../state/merge-manager-slice';
import type {NotLandedSection as Section} from './not-landed-rows';

export function NotLandedSection({
    section,
    now,
    selected,
    busy,
    onSelect,
}: {
    section: Section;
    now: number;
    selected: string | null;
    /** The slice's lands under way, by key (`landedKey`, which `notLandedKey` shares). */
    busy: Readonly<Record<string, LandAction>>;
    onSelect: (key: string) => void;
}): JSX.Element | null {
    if (section.rows.length === 0) return null;
    return (
        <section className="mm-card mm-lanecard mm-nl" role="group" aria-label="Not landed">
            <div className="mm-lanehead">
                <h2>Not landed</h2>
                <span className="mm-lanehead-meta">your newest open pull requests that are not in a lane</span>
                <span className="mm-lanehead-gap" />
                <span className="mm-lanehead-meta">
                    <kbd className="sw-kbd">L</kbd> land the chosen one
                </span>
            </div>
            {section.rows.map((pr) => (
                <NotLandedRow
                    key={notLandedKey(pr)}
                    pr={pr}
                    now={now}
                    selected={selected === notLandedKey(pr)}
                    busy={busy[notLandedKey(pr)] === 'land'}
                    onSelect={onSelect}
                />
            ))}
            {section.more > 0 && (
                <div className="mm-nl-more">
                    <button type="button" className="sw-btn" onClick={openNotLandedPage}>
                        View all {section.total}
                    </button>
                    <span>· {section.more} more</span>
                </div>
            )}
        </section>
    );
}

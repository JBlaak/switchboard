/**
 * Coming up, on top of the Merge manager's page: the next hour (or hours) of
 * turns on a timeline, one track per lane, from now.
 *
 * Each track's name carries its lane's facts (its kind, one CI run, when it
 * is clear, and whether updating the head loses its approval); its blocks
 * the PRs that move, each with a pin under its end for when it merges ("≈"
 * when rough); flags standing on it for the parked ones (held, fixing, needs
 * you), where they keep their place; and under it the repository's not
 * landed PRs counted by group. A footer sums it up, with View all for the
 * Not landed page.
 *
 * A block or a flag selects its PR; a count scrolls to its group.
 */
import type {JSX} from 'react';
import {notLandedCounts, type StatusGroup, type StatusGroupId} from '../../../domain/merge-manager/status';
import type {PageLane} from '../../../domain/merge-manager/page';
import type {LaneTimes, Timeline} from '../../../domain/merge-manager/times';
import {openNotLandedPage} from './not-landed-actions';
import {clock, comingUpFooter, countText, flagText, laneFacts, repositoryName, timePins} from './status-view';

export function ComingUp({
    line,
    lanes,
    times,
    groups,
    notLanded,
    selected,
    onSelect,
    onGo,
}: {
    line: Timeline;
    lanes: readonly PageLane[];
    times: ReadonlyMap<string, LaneTimes>;
    groups: readonly StatusGroup[];
    /** How many of the user's open PRs are not landed. */
    notLanded: number;
    selected: string | null;
    onSelect: (key: string) => void;
    onGo: (id: StatusGroupId) => void;
}): JSX.Element {
    const span = line.to - line.from;
    const left = (at: number): string => ((at - line.from) / span) * 100 + '%';
    const hours = span > 60 * 60_000;
    const footer = comingUpFooter(line, times, notLanded);
    const summary = [footer.landed, footer.parked, footer.notLanded].filter((part): part is string => !!part);
    return (
        <section className="mm-card mm-timeline" aria-label="Coming up">
            <div className="mm-card-head">
                <h2>{hours ? `The next ${Math.round(span / 3_600_000)} hours` : 'The next hour'}</h2>
                {line.tracks.some((track) => track.blocks.some((block) => block.rough)) && (
                    <span>Dashed and ≈: rough, further back in its lane</span>
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
                {line.tracks.map((track) => {
                    const laneTimes = times.get(track.repository);
                    const facts = laneFacts(
                        lanes.find((lane) => lane.repository === track.repository),
                        laneTimes,
                    );
                    const counts = notLandedCounts(groups, track.repository);
                    return (
                        <div key={track.repository} className="mm-tl-row">
                            <div className="mm-tl-name" title={facts.title}>
                                <span className="mm-tl-repo">{repositoryName(track.repository)}</span>
                                <span className="mm-tl-facts">{facts.line}</span>
                                {facts.warning && <span className="mm-tl-warn">{facts.warning}</span>}
                            </div>
                            <div className={'mm-tl-lane' + (track.flags.length > 0 ? ' has-flags' : '')}>
                                <div className="mm-tl-track">
                                    {line.ticks.map((at) => (
                                        <i
                                            key={at}
                                            className="mm-tl-tick"
                                            style={{left: left(at)}}
                                            aria-hidden="true"
                                        />
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
                                <div className="mm-tl-pins" aria-hidden="true">
                                    {timePins(track.blocks, laneTimes).map((pin) => (
                                        <span key={pin.key} style={{width: pin.at * 100 + '%'}}>
                                            {pin.text}
                                        </span>
                                    ))}
                                </div>
                                {track.flags.map((flag) => (
                                    <button
                                        key={flag.keys.join(',')}
                                        type="button"
                                        className={
                                            'mm-tl-flag is-' +
                                            flag.tone +
                                            (flag.at > 0.85 ? ' is-end' : '') +
                                            (flag.keys.includes(selected ?? '') ? ' is-selected' : '')
                                        }
                                        style={{left: flag.at * 100 + '%'}}
                                        title={flag.title}
                                        onClick={() => onSelect(flag.keys[0]!)}>
                                        <i aria-hidden="true" />
                                        <span>{flagText(flag)}</span>
                                    </button>
                                ))}
                                {counts.length > 0 && (
                                    <div className="mm-tl-counts">
                                        +{' '}
                                        {counts.map((count, index) => (
                                            <span key={count.id}>
                                                {index > 0 && ' · '}
                                                <button type="button" onClick={() => onGo(count.id)}>
                                                    {countText(count)}
                                                </button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            {summary.length > 0 && (
                <div className="mm-tl-foot">
                    <span>{summary.join(' · ')}</span>
                    {notLanded > 0 && (
                        <button type="button" className="sw-btn sw-btn-small" onClick={openNotLandedPage}>
                            View all
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}

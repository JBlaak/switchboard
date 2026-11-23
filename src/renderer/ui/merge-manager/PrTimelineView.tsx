/**
 * A PR's own timeline on the Merge manager's page (`PrTimeline`): the seven
 * stations in a row, each a dot with the line to the next, its label and
 * sub under it and how long the stretch took over the line. While it is at
 * the head the line to Merged splits into the head's three steps, their
 * labels over them. The stretch that runs now is a `TimedBar`: it fills
 * toward its expected time and slides once it runs past it.
 *
 * Marks: done grey and filled, now in the group's tone with a soft ring,
 * stopped orange "!", conflict red "!", fixing yellow "↻", held hollow "‖",
 * todo hollow, its line dashed.
 */
import type {JSX} from 'react';
import type {HeadPartId, PrTimeline, StationId, StationMark} from '../../../domain/merge-manager/pr-timeline';
import type {StatusTone} from '../../../domain/merge-manager/status';
import {TimedBar} from './TimedBar';

const HEAD_PARTS: readonly string[] = ['update', 'checks', 'merge'] satisfies HeadPartId[];

function isHeadPart(id: StationId | HeadPartId): boolean {
    return HEAD_PARTS.includes(id);
}

const SIGN: Partial<Record<StationMark, string>> = {stopped: '!', conflict: '!', fixing: '↻', held: '‖'};

export function PrTimelineView({
    timeline,
    tone,
    seenKey,
}: {
    timeline: PrTimeline;
    /** The group's tone, which the now mark is drawn in. */
    tone: StatusTone;
    /** The PR's key: what the live bar times from when the read gives no start. */
    seenKey: string;
}): JSX.Element {
    const {stations, headParts, live} = timeline;

    /**
     * The line after a station or one of the head's steps; `mark` is what it
     * leads to (or the step's own). `live.after` names a head step while the
     * head's steps show ('checks' is then the step, not the station).
     */
    const segment = (after: StationId | HeadPartId, mark: StationMark, part: boolean): JSX.Element =>
        live?.after === after && part === (headParts !== null && isHeadPart(after)) ? (
            <TimedBar className="mm-prt-seg mm-prt-bar" timing={live.timing} seenKey={`${seenKey}|${after}`} />
        ) : (
            <span className={'mm-prt-seg is-' + mark} />
        );

    return (
        <div className={'mm-prt is-tone-' + tone} role="img" aria-label={timeline.label}>
            {stations.map((station, index) => {
                const next = stations[index + 1];
                const split = station.id === 'head' && headParts && next;
                return (
                    <div
                        key={station.id}
                        className={
                            'mm-prt-st is-' + station.mark + (split ? ' is-split' : '') + (next ? '' : ' is-last')
                        }>
                        <div className="mm-prt-rail">
                            <span className="mm-prt-dot" aria-hidden="true">
                                {SIGN[station.mark]}
                            </span>
                            {next &&
                                (split ? (
                                    <span className="mm-prt-parts">
                                        {headParts.map((part) => (
                                            <span key={part.id} className={'mm-prt-part is-' + part.mark}>
                                                <span className="mm-prt-over">{part.label}</span>
                                                {segment(part.id, part.mark, true)}
                                            </span>
                                        ))}
                                    </span>
                                ) : (
                                    <span className="mm-prt-line">
                                        {station.duration && <span className="mm-prt-over">{station.duration}</span>}
                                        {segment(station.id, next.mark === 'todo' ? 'todo' : 'done', false)}
                                    </span>
                                ))}
                        </div>
                        <div className="mm-prt-text">
                            <span className="mm-prt-label">{station.label}</span>
                            {station.sub && <span className="mm-prt-sub">{station.sub}</span>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

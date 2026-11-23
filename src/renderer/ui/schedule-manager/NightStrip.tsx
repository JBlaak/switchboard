/**
 * The night (`domain/schedule/night`): last night and tonight, 22:00 to
 * 08:00, a block per run coloured by how it went, tonight's coming runs as
 * outlines, and the Mac's wake as a marker. A block opens its schedule.
 */
import type {JSX} from 'react';
import {nightStrip, nightSummaryParts, type NightTrack} from '../../../domain/schedule/night';
import {shareText} from '../../../domain/schedule/times';
import type {ScheduleManagerFacts} from '../../../domain/schedule/manager';
import {openScheduleManager} from './actions';

export function NightStrip({facts, now}: {facts: ScheduleManagerFacts; now: number}): JSX.Element {
    const strip = nightStrip(facts, now);
    const parts = nightSummaryParts(strip.summary);
    return (
        <section className="sm-card sm-night" aria-label="The night">
            <div className="sm-night-head">
                <h2 className="sm-label">The night</h2>
                <span className="sm-night-summary">
                    {parts.length === 0 ? (
                        'Nothing ran last night'
                    ) : (
                        <>
                            Last night:{' '}
                            {parts.map((part, index) => (
                                <span key={part.tone}>
                                    {index > 0 && ' · '}
                                    <b className={`is-${part.tone}`}>{part.text}</b>
                                </span>
                            ))}
                            {strip.summary.weekUsed !== null &&
                                ` · used ${shareText(strip.summary.weekUsed)} of the week`}
                        </>
                    )}
                </span>
                <span className="sm-night-span">22:00 → 08:00</span>
            </div>
            <div className="sm-night-grid">
                <span className="sm-night-name">Last night</span>
                <Track track={strip.lastNight} />
                <span className="sm-night-name">Tonight</span>
                <Track track={strip.tonight} wake={strip.wake} />
                <span />
                <div className="sm-night-axis" aria-hidden="true">
                    {strip.ticks.map((tick, index) => (
                        <span
                            key={tick.label}
                            className={
                                index === 0 ? 'is-start' : index === strip.ticks.length - 1 ? 'is-end' : undefined
                            }
                            style={{left: `${tick.left}%`}}>
                            {tick.label}
                        </span>
                    ))}
                    {strip.wake && (
                        <span className="is-wake" style={{left: `${strip.wake.left}%`}}>
                            wake {strip.wake.at}
                        </span>
                    )}
                </div>
            </div>
        </section>
    );
}

function Track({track, wake}: {track: NightTrack; wake?: {at: string; left: number} | null}): JSX.Element {
    return (
        <div className="sm-night-track">
            {wake && (
                <span className="sm-night-wake" style={{left: `${wake.left}%`}} title={`The Mac wakes at ${wake.at}`} />
            )}
            {track.blocks.map((block) => (
                <button
                    key={block.id}
                    type="button"
                    className={`sm-night-block is-${block.tone}${block.planned ? ' is-planned' : ''}`}
                    style={{left: `${block.left}%`, width: `${block.width}%`}}
                    title={block.label}
                    aria-label={block.planned ? `${block.label}, coming` : block.label}
                    onClick={() => openScheduleManager(block.scheduleKey)}
                />
            ))}
        </div>
    );
}

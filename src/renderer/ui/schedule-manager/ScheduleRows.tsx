/**
 * A schedule on the overview: a large card while it needs you (its last
 * run's report, its pill, Open run and Seen), a compact row otherwise (name,
 * project, cadence, where it runs, its last runs as small squares, its next
 * run and what the last one said), and a Turn on button for a new or paused
 * one. A click chooses it; its name opens its page.
 */
import type {JSX, ReactNode} from 'react';
import {describeCron} from '../../../domain/schedule/cadence';
import {statusTone} from '../../../domain/schedule/night';
import {projectName, rowSideText, runPill, runsOnText} from '../../../domain/schedule/page';
import {minutesText, nextRunText, shareText} from '../../../domain/schedule/times';
import type {RunStatus, ScheduleSummary} from '../../../domain/schedule/manager';
import {markSeen, openRun, openScheduleManager, selectSchedule, setEnabled} from './actions';

interface RowProps {
    readonly schedule: ScheduleSummary;
    readonly selected: boolean;
    readonly busy: boolean;
    readonly now: number;
}

/** The last runs as squares, oldest first. */
export function LastRuns({statuses, label}: {statuses: readonly RunStatus[]; label?: string}): JSX.Element | null {
    if (statuses.length === 0) return null;
    const counts = statuses.reduce<Record<string, number>>((all, status) => {
        all[status] = (all[status] ?? 0) + 1;
        return all;
    }, {});
    const said = Object.entries(counts)
        .map(([status, n]) => `${n} ${status}`)
        .join(', ');
    return (
        <div className="sm-squares-box">
            <div className="sm-squares" role="img" aria-label={`Last ${statuses.length} runs: ${said}`}>
                {statuses.map((status, index) => (
                    <span key={index} className={`sm-square is-${statusTone(status)}`} />
                ))}
            </div>
            {label && <span className="sm-squares-label">{label}</span>}
        </div>
    );
}

function Pill({text, tone}: {text: string; tone: string}): JSX.Element {
    return <span className={`sm-pill is-${tone}`}>{text}</span>;
}

function Dot({tone}: {tone: string}): JSX.Element {
    return <span className={`sm-dot is-${tone}`} aria-hidden="true" />;
}

function Row({
    schedule,
    selected,
    className,
    children,
}: {
    schedule: ScheduleSummary;
    selected: boolean;
    className: string;
    children: ReactNode;
}): JSX.Element {
    return (
        <div
            className={`sm-row ${className}${selected ? ' is-selected' : ''}`}
            data-schedule-key={schedule.key}
            role="option"
            aria-selected={selected}
            onClick={() => selectSchedule(schedule.key)}>
            {children}
        </div>
    );
}

function Name({schedule, children}: {schedule: ScheduleSummary; children?: ReactNode}): JSX.Element {
    return (
        <button
            type="button"
            className="sm-name"
            onClick={(e) => {
                e.stopPropagation();
                openScheduleManager(schedule.key);
            }}>
            {schedule.settings.name}
            {children}
        </button>
    );
}

function Meta({schedule, withVersion}: {schedule: ScheduleSummary; withVersion?: boolean}): JSX.Element {
    return (
        <span className="sm-meta">
            <span className="sm-project" title={schedule.settings.projectPath}>
                {projectName(schedule.settings.projectPath)}
            </span>
            <span>{describeCron(schedule.settings.cron)}</span>
            <span>{runsOnText(schedule.runsOn)}</span>
            {withVersion && <span>prompt v{schedule.promptVersion}</span>}
        </span>
    );
}

function typicalText(schedule: ScheduleSummary): string | null {
    const parts = [
        schedule.typicalMinutes === null ? null : `~${minutesText(schedule.typicalMinutes)}`,
        schedule.typicalWeekShare === null ? null : `${shareText(schedule.typicalWeekShare)} of week a run`,
    ].filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join(' · ');
}

/** Needs you: the last run's report, its pill, and Open run and Seen. */
export function NeedsYouCard({schedule, selected, busy, now}: RowProps): JSX.Element {
    const last = schedule.last;
    const pill = last ? runPill(last) : null;
    const typical = typicalText(schedule);
    return (
        <Row schedule={schedule} selected={selected} className="is-card">
            <Dot tone={last ? statusTone(last.status, last.trigger === 'catch-up') : 'failed'} />
            <div className="sm-row-main">
                <div className="sm-row-title">
                    <Name schedule={schedule} />
                    {pill && <Pill {...pill} />}
                </div>
                {(last?.report || last?.reason) && <p className="sm-report-line">{last.report ?? last.reason}</p>}
                <Meta schedule={schedule} withVersion />
            </div>
            <LastRuns statuses={schedule.lastRuns} label={`last ${schedule.lastRuns.length} runs`} />
            <div className="sm-row-side">
                {schedule.settings.enabled && schedule.nextRunAt !== null && (
                    <span>
                        next <b>{nextRunText(schedule.nextRunAt, now)}</b>
                    </span>
                )}
                {typical && <span>{typical}</span>}
                {last && (
                    <span className="sm-row-actions">
                        <button
                            type="button"
                            className="sw-btn sw-btn-small"
                            onClick={(e) => {
                                e.stopPropagation();
                                openRun(schedule.key, last.id);
                            }}>
                            Open run
                        </button>
                        {!last.seen && (
                            <button
                                type="button"
                                className="sw-btn sw-btn-small"
                                disabled={busy}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void markSeen(last.id);
                                }}>
                                Seen
                            </button>
                        )}
                    </span>
                )}
            </div>
        </Row>
    );
}

/** Scheduled and running: one line each. */
export function ScheduleRow({schedule, selected, now}: RowProps): JSX.Element {
    const running = schedule.group === 'running';
    return (
        <Row schedule={schedule} selected={selected} className="is-compact">
            <Dot tone={running ? 'running' : schedule.last ? statusTone(schedule.last.status) : 'done'} />
            <div className="sm-row-main">
                <Name schedule={schedule}>
                    {running && <span className="sm-running"> · {rowSideText(schedule, now)}</span>}
                </Name>
                <Meta schedule={schedule} />
            </div>
            <LastRuns statuses={schedule.lastRuns} />
            <span className="sm-row-side">{running ? (typicalText(schedule) ?? '') : rowSideText(schedule, now)}</span>
        </Row>
    );
}

/** New and Paused: off, with a Turn on button. */
export function OffRow({schedule, selected, busy}: RowProps): JSX.Element {
    return (
        <Row schedule={schedule} selected={selected} className="is-compact is-off">
            <Dot tone="skipped" />
            <div className="sm-row-main">
                <Name schedule={schedule} />
                <Meta schedule={schedule} />
            </div>
            <LastRuns statuses={schedule.lastRuns} />
            <span className="sm-row-side">
                <button
                    type="button"
                    className="sw-btn sw-btn-small"
                    disabled={busy}
                    onClick={(e) => {
                        e.stopPropagation();
                        void setEnabled(schedule.key, true);
                    }}>
                    Turn on
                </button>
            </span>
        </Row>
    );
}

/**
 * The Schedule manager's overview: its figure and line in the header, with
 * New schedule and, while the Mac does not wake for the night's runs, the
 * wake to set; the night strip; then the schedules by group (Needs you as
 * cards, Scheduled as rows, New to turn on, Paused folded), and the keys.
 */
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {
    headerLine,
    overviewGroups,
    scheduleFigureOf,
    wakeOffer,
    type OverviewGroup,
} from '../../../domain/schedule/page-view';
import type {ScheduleManagerFacts} from '../../../domain/schedule/manager';
import {SceneFigure} from '../bug-manager/ManagerFigure';
import {CloseIcon} from '../merge-manager/CloseIcon';
import {sameScheduleFigure, scheduleScene} from './figure-scene';
import {NightStrip} from './NightStrip';
import {NeedsYouCard, OffRow, ScheduleRow} from './ScheduleRows';
import {closeScheduleManager, openCreateSchedule, setWake, showPaused} from './actions';

const GROUP_HEADS: Record<OverviewGroup['id'], {title: string; hint: string}> = {
    needsYou: {title: 'Needs you', hint: 'failed, missed or stopped by its limit, and not looked at yet'},
    scheduled: {title: 'Scheduled', hint: 'by next run'},
    new: {title: 'New', hint: 'written outside Switchboard, off until you turn it on'},
    paused: {title: 'Paused', hint: ''},
};

export function Overview({facts, now}: {facts: ScheduleManagerFacts; now: number}): JSX.Element {
    const page = useStore((state) => state.scheduleManager.page);
    const figure = useStore((state) => scheduleFigureOf(state.scheduleManager.facts), sameScheduleFigure);
    const groups = overviewGroups(facts.schedules);
    const wake = wakeOffer(facts);
    const busy = page.busy !== null;

    return (
        <>
            <header className="sw-header pp-header sm-header">
                <div className="sw-header-row">
                    <button
                        type="button"
                        className="sw-btn sw-back"
                        onClick={closeScheduleManager}
                        aria-label="Close the Schedule manager (Esc)">
                        <CloseIcon />
                        Close <kbd className="sw-kbd">esc</kbd>
                    </button>
                    <SceneFigure scene={scheduleScene(figure, '')} />
                    <div className="sw-heading">
                        <h1 className="sw-title pp-title">Schedule manager</h1>
                        <div className="sw-subline pp-subline">
                            <span>{headerLine(facts, now)}</span>
                        </div>
                    </div>
                    <div className="pp-header-actions">
                        {wake && (
                            <button
                                type="button"
                                className="sw-btn"
                                disabled={busy}
                                onClick={() => void setWake(wake)}
                                title="Asks for your password: macOS sets a repeating wake with pmset">
                                Wake the Mac at {wake}
                            </button>
                        )}
                        <button type="button" className="sw-btn is-primary" onClick={() => openCreateSchedule()}>
                            New schedule <kbd className="sw-kbd">N</kbd>
                        </button>
                    </div>
                </div>
            </header>

            {page.notice && (
                <div className="tk-status" role="status">
                    {page.notice}
                </div>
            )}

            <div className="sm-body">
                {facts.schedules.length === 0 ? (
                    <EmptyLine />
                ) : (
                    <>
                        <NightStrip facts={facts} now={now} />
                        <div className="sm-groups" role="listbox" aria-label="Schedules">
                            {groups.map((group) =>
                                group.id === 'paused' ? (
                                    <PausedGroup
                                        key={group.id}
                                        group={group}
                                        shown={page.showPaused}
                                        busy={busy}
                                        now={now}
                                    />
                                ) : (
                                    <section
                                        key={group.id}
                                        className={`sm-group is-${group.id}`}
                                        data-group={group.id}
                                        role="group"
                                        aria-label={GROUP_HEADS[group.id].title}>
                                        <GroupHead id={group.id} />
                                        {group.schedules.map((schedule) => {
                                            const props = {
                                                schedule,
                                                selected: page.selected === schedule.key,
                                                busy,
                                                now,
                                            };
                                            if (group.id === 'needsYou')
                                                return <NeedsYouCard key={schedule.key} {...props} />;
                                            if (group.id === 'new') return <OffRow key={schedule.key} {...props} />;
                                            return <ScheduleRow key={schedule.key} {...props} />;
                                        })}
                                    </section>
                                ),
                            )}
                        </div>
                    </>
                )}
            </div>

            <footer className="tk-keys" aria-label="Keys">
                <span>
                    <kbd className="sw-kbd">J</kbd>/<kbd className="sw-kbd">K</kbd> move
                </span>
                <span>
                    <kbd className="sw-kbd">↵</kbd> open
                </span>
                <span>
                    <kbd className="sw-kbd">R</kbd> run now
                </span>
                <span>
                    <kbd className="sw-kbd">P</kbd> pause / resume
                </span>
                <span>
                    <kbd className="sw-kbd">E</kbd> edit prompt
                </span>
                <span>
                    <kbd className="sw-kbd">S</kbd> seen
                </span>
                <span>
                    <kbd className="sw-kbd">N</kbd> new
                </span>
                <span>
                    <kbd className="sw-kbd">⌘J</kbd> Schedule manager
                </span>
            </footer>
        </>
    );
}

function GroupHead({id}: {id: OverviewGroup['id']}): JSX.Element {
    const head = GROUP_HEADS[id];
    return (
        <div className="sm-group-head">
            <h2 className={`sm-label is-${id}`}>{head.title}</h2>
            {head.hint && <span>{head.hint}</span>}
        </div>
    );
}

/** Paused, folded to a line until shown. */
function PausedGroup({
    group,
    shown,
    busy,
    now,
}: {
    group: OverviewGroup;
    shown: boolean;
    busy: boolean;
    now: number;
}): JSX.Element {
    const selected = useStore((state) => state.scheduleManager.page.selected);
    return (
        <section className="sm-group is-paused" data-group="paused" role="group" aria-label="Paused">
            <div className="sm-paused-head">
                <h2 className="sm-label is-paused">Paused</h2>
                <span>
                    {group.schedules.length} · {group.schedules.map((schedule) => schedule.settings.name).join(', ')}
                </span>
                <button type="button" className="sm-link" aria-expanded={shown} onClick={() => showPaused(!shown)}>
                    {shown ? 'Hide ▴' : 'Show ▾'}
                </button>
            </div>
            {shown &&
                group.schedules.map((schedule) => (
                    <OffRow
                        key={schedule.key}
                        schedule={schedule}
                        selected={selected === schedule.key}
                        busy={busy}
                        now={now}
                    />
                ))}
        </section>
    );
}

function EmptyLine(): JSX.Element {
    return (
        <div className="sm-empty">
            <p>
                No schedules yet. A schedule runs Claude Code on its own, at night or whenever you say, on your own
                subscription.
            </p>
            <button type="button" className="sw-btn is-primary" onClick={() => openCreateSchedule()}>
                New schedule <kbd className="sw-kbd">N</kbd>
            </button>
        </div>
    );
}

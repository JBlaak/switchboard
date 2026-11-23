/**
 * One schedule's page: its name, whether it is on, its project, cadence and
 * next run, with Pause or Turn on, Skip the next run and Run now; its stats;
 * its runs newest first (`domain/schedule/run-list`, a marker wherever the
 * prompt changed), each unfolding to its report, its worktree, the week
 * before and after, Carry on in a session, Tune the prompt from this run and
 * Seen; and beside them the prompt card and the settings card.
 */
import {useEffect, useState, type JSX} from 'react';
import {useStore} from '../use-store';
import {describeCron} from '../../../domain/schedule/cadence';
import {runTone} from '../../../domain/schedule/night';
import {projectName, runPill, statusWord} from '../../../domain/schedule/page-view';
import {firstRunItems, runListItems} from '../../../domain/schedule/run-list';
import {
    clockOf,
    minutesText,
    nextRunText,
    runMinutes,
    runShare,
    runWhen,
    shareText,
    shortDate,
    untilText,
} from '../../../domain/schedule/times';
import type {ScheduleDetail, ScheduleRun} from '../../../domain/schedule/manager';
import {carryOn, markSeen, openScheduleManager, runNow, setEnabled, skipNext, toggleRun, tuneFromRun} from './actions';
import {PromptCard} from './PromptCard';
import {SettingsCard} from './SettingsCard';

/** The runs shown before Show older. */
const FIRST_RUNS = 15;

export function ScheduleView({scheduleKey, now}: {scheduleKey: string; now: number}): JSX.Element {
    const page = useStore((state) => state.scheduleManager.page);
    const detail = page.detail;
    if (!detail) {
        return (
            <>
                <BackBar />
                <div className="sm-body">
                    <p className="sm-empty">{page.notice ?? 'Reading the schedule…'}</p>
                </div>
            </>
        );
    }
    return <Loaded scheduleKey={scheduleKey} detail={detail} now={now} />;
}

function BackBar(): JSX.Element {
    return (
        <button type="button" className="sm-back" onClick={() => openScheduleManager(null)}>
            ← Schedule manager <kbd className="sw-kbd">esc</kbd>
        </button>
    );
}

function Loaded({scheduleKey, detail, now}: {scheduleKey: string; detail: ScheduleDetail; now: number}): JSX.Element {
    const page = useStore((state) => state.scheduleManager.page);
    const {summary, stats} = detail;
    const {settings} = summary;
    const busy = page.busy !== null;
    const [showAll, setShowAll] = useState(false);
    const items = runListItems(detail.runs, detail.versions, summary.promptVersion, now);
    const shown = showAll ? items : firstRunItems(items, FIRST_RUNS);
    const older = detail.runs.length - Math.min(detail.runs.length, FIRST_RUNS);

    // The chosen run stays in view.
    useEffect(() => {
        if (!page.selectedRun) return;
        document
            .querySelector(`#schedule-manager-page [data-run-id="${CSS.escape(page.selectedRun)}"]`)
            ?.scrollIntoView({block: 'nearest'});
    }, [page.selectedRun]);

    return (
        <>
            <header className="sw-header sm-header">
                <BackBar />
                <div className="sw-header-row">
                    <div className="sw-heading">
                        <div className="sm-title-row">
                            <h1 className="sw-title pp-title">{settings.name}</h1>
                            <span className={`sm-pill ${settings.enabled ? 'is-done' : 'is-skipped'}`}>
                                {settings.enabled ? 'ON' : 'OFF'}
                            </span>
                        </div>
                        <div className="sw-subline pp-subline">
                            <span className="sm-project" title={settings.projectPath}>
                                {projectName(settings.projectPath)}
                            </span>
                            <span>{describeCron(settings.cron)}</span>
                            {settings.enabled && summary.nextRunAt !== null && (
                                <span>
                                    next {nextRunText(summary.nextRunAt, now)} ({untilText(summary.nextRunAt, now)})
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="pp-header-actions">
                        <button
                            type="button"
                            className="sw-btn"
                            disabled={busy}
                            onClick={() => void setEnabled(scheduleKey, !settings.enabled)}>
                            {settings.enabled ? 'Pause' : 'Turn on'} <kbd className="sw-kbd">P</kbd>
                        </button>
                        {settings.enabled && summary.nextRunAt !== null && (
                            <button
                                type="button"
                                className="sw-btn"
                                disabled={busy}
                                onClick={() => void skipNext(scheduleKey)}>
                                {nextRunText(summary.nextRunAt, now).startsWith('tonight')
                                    ? 'Skip tonight'
                                    : 'Skip next run'}
                            </button>
                        )}
                        <button
                            type="button"
                            className="sw-btn is-primary"
                            disabled={busy}
                            onClick={() => void runNow(scheduleKey)}>
                            Run now <kbd className="sw-kbd">R</kbd>
                        </button>
                    </div>
                </div>
                <Stats stats={stats} />
            </header>

            {page.notice && (
                <div className="tk-status" role="status">
                    {page.notice}
                </div>
            )}

            <div className="sm-body sm-schedule">
                <section className="sm-runs" aria-label="Runs">
                    <div className="sm-group-head">
                        <h2 className="sm-label">Runs</h2>
                        <span>newest first · each run is a session you can open and carry on</span>
                    </div>
                    {detail.runs.length === 0 && <p className="sm-empty">No runs yet. Run now to try it.</p>}
                    <div role="listbox" aria-label="Runs">
                        {shown.map((item) =>
                            item.kind === 'run' ? (
                                <RunRow
                                    key={item.run.id}
                                    scheduleKey={scheduleKey}
                                    run={item.run}
                                    selected={page.selectedRun === item.run.id}
                                    expanded={page.expandedRun === item.run.id}
                                    busy={busy}
                                    now={now}
                                />
                            ) : (
                                <div key={`v${item.version}`} className="sm-prompt-marker" role="separator">
                                    <span>{item.text}</span>
                                </div>
                            ),
                        )}
                    </div>
                    {!showAll && older > 0 && (
                        <button type="button" className="sm-link" onClick={() => setShowAll(true)}>
                            Show {older} older {older === 1 ? 'run' : 'runs'}
                        </button>
                    )}
                </section>

                <aside className="sm-side">
                    <PromptCard scheduleKey={scheduleKey} detail={detail} now={now} />
                    <SettingsCard detail={detail} />
                </aside>
            </div>

            <footer className="tk-keys" aria-label="Keys">
                <span>
                    <kbd className="sw-kbd">J</kbd>/<kbd className="sw-kbd">K</kbd> runs
                </span>
                <span>
                    <kbd className="sw-kbd">↵</kbd> unfold
                </span>
                <span>
                    <kbd className="sw-kbd">C</kbd> carry on
                </span>
                <span>
                    <kbd className="sw-kbd">S</kbd> seen
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
                    <kbd className="sw-kbd">esc</kbd> all schedules
                </span>
            </footer>
        </>
    );
}

function Stats({stats}: {stats: ScheduleDetail['stats']}): JSX.Element | null {
    if (stats.total === 0) return null;
    return (
        <div className="sm-stats">
            <span>
                <b>{stats.total}</b> {stats.total === 1 ? 'run' : 'runs'}
                {stats.since !== null && ` since ${shortDate(stats.since)}`}
            </span>
            <span>
                <b>{stats.done}</b> done · <b className="is-failed">{stats.failed}</b> failed ·{' '}
                <b className="is-late">{stats.caughtUp}</b> caught up
            </span>
            {(stats.medianMinutes !== null || stats.medianWeekShare !== null) && (
                <span>
                    median {stats.medianMinutes !== null && <b>{minutesText(stats.medianMinutes)}</b>}
                    {stats.medianMinutes !== null && stats.medianWeekShare !== null && ' · '}
                    {stats.medianWeekShare !== null && (
                        <>
                            <b>{shareText(stats.medianWeekShare)}</b> of your week a run
                        </>
                    )}
                </span>
            )}
            {stats.thisWeekShare !== null && (
                <span>
                    <b>{shareText(stats.thisWeekShare)}</b> of this week so far
                </span>
            )}
        </div>
    );
}

function RunRow({
    scheduleKey,
    run,
    selected,
    expanded,
    busy,
    now,
}: {
    scheduleKey: string;
    run: ScheduleRun;
    selected: boolean;
    expanded: boolean;
    busy: boolean;
    now: number;
}): JSX.Element {
    const at = run.startedAt ?? run.dueAt;
    const when = at === null ? {title: 'Not started', sub: null} : runWhen(at, now);
    const due = run.trigger === 'catch-up' && run.dueAt !== null ? `due ${clockOf(run.dueAt)}` : null;
    const pill = runPill(run);
    const minutes = runMinutes(run, now);
    const share = runShare(run);
    // The pill says the status already where there is one.
    const said = [pill ? null : statusWord(run), run.reason, `prompt v${run.promptVersion}`]
        .filter(Boolean)
        .join(' · ');
    return (
        <div
            className={`sm-run${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}`}
            data-run-id={run.id}
            role="option"
            aria-selected={selected}
            aria-expanded={expanded}>
            <button type="button" className="sm-run-head" onClick={() => toggleRun(run.id)}>
                <span className="sm-run-when">
                    <b>{when.title}</b>
                    {when.sub && <span>{when.sub}</span>}
                    {due && <span>{due}</span>}
                </span>
                <span className="sm-run-what">
                    <span className="sm-run-status">
                        {pill ? (
                            <span className={`sm-pill is-${pill.tone}`}>{pill.text}</span>
                        ) : (
                            <span className={`sm-dot is-${runTone(run)}`} aria-hidden="true" />
                        )}
                        <span>{said}</span>
                    </span>
                    {run.report && !expanded && <span className="sm-run-report">{run.report}</span>}
                </span>
                <span className="sm-run-cost">
                    <span>{minutes === null ? '–' : minutesText(minutes)}</span>
                    {share !== null && (
                        <span className={pill?.tone === 'failed' ? 'is-failed' : ''}>{shareText(share)}</span>
                    )}
                </span>
            </button>
            {expanded && (
                <div className="sm-run-body">
                    {run.report && (
                        <div className="sm-run-full">
                            <span className="sm-label is-report">The run&rsquo;s report</span>
                            <p>{run.report}</p>
                        </div>
                    )}
                    <div className="sm-run-facts">
                        {run.worktree && (
                            <span>
                                Worktree <code>{run.worktree}</code>
                            </span>
                        )}
                        {run.weekBefore !== null && run.weekAfter !== null && (
                            <span>
                                Week at {Math.round(run.weekBefore)}% → {Math.round(run.weekAfter)}%
                            </span>
                        )}
                        {run.trigger === 'manual' && <span>Run now</span>}
                        {run.trigger === 'try' && <span>A try from the create form</span>}
                    </div>
                    <div className="sm-run-actions">
                        {run.sessionId && (
                            <button type="button" className="sw-btn is-primary" onClick={() => void carryOn(run)}>
                                Carry on in a session <kbd className="sw-kbd">C</kbd>
                            </button>
                        )}
                        {run.status !== 'running' && run.status !== 'skipped' && (
                            <button
                                type="button"
                                className="sw-btn"
                                disabled={busy}
                                onClick={() => void tuneFromRun(scheduleKey, run)}>
                                Tune the prompt from this run
                            </button>
                        )}
                        {!run.seen && run.status !== 'running' && (
                            <button type="button" className="sw-btn" onClick={() => void markSeen(run.id)}>
                                Seen <kbd className="sw-kbd">S</kbd>
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

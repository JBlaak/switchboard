/**
 * Creating a schedule: say it in one sentence, Claude drafts the rest, you
 * review a filled-in form.
 *
 * 1. Describe it: "What should it do, and when?", the project, and starters
 *    (a few sentences to edit, or a copy of a schedule, which goes straight
 *    to step 2). Cancel, Write it myself (step 2, blank) or Draft it, which
 *    waits on Claude (10–30 s) and shows why it failed, keeping the sentence.
 *    Opened from a session, this step is skipped: Claude drafts from what
 *    the session did as it opens.
 * 2. Review the draft: `ScheduleForm` with the prompt, why Claude picked the
 *    time, and where it saves. Back, Save and try it now, or Save; saved, the
 *    dialog closes and the schedule's page opens.
 *
 * Keys: ⏎ drafts in step 1 (⇧⏎ is a new line), ⌘⏎ saves in step 2, Esc goes
 * back from step 2 and closes from step 1. Tab stays inside the dialog.
 */
import {useEffect, useRef} from 'react';
import type {JSX, KeyboardEvent} from 'react';
import {dispatch} from '../../state/app-store';
import {shallowEqual} from '../../state/store';
import {sessionMap, view} from '../../state/session-store';
import {sessionRecency} from '../../../domain/project/project-recency';
import {worktreeParentPath} from '../../../domain/project/project-path';
import {scheduleFileHint, scheduleSettingsProblem} from '../../../domain/schedule/form';
import {projectLabel} from '../../features/sessions/project-label';
import {useStore} from '../use-store';
import {DialogShell} from '../dialogs/DialogShell';
import {ScheduleForm} from './ScheduleForm';
import {
    SCHEDULE_STARTERS,
    copyChoices,
    defaultProjectPath,
    localProjectChoices,
    takenSlugs,
    withNewName,
} from './create-view';
import {copySchedule, draftFromSession, draftSchedule, saveNewSchedule, writeScheduleYourself} from './create-actions';
import type {ScheduleSettings} from '../../../domain/schedule/manager';

export function CreateScheduleDialog({onClose}: {onClose(): void}): JSX.Element {
    const create = useStore((state) => state.scheduleCreate);
    const {schedules, onScreen} = useStore(
        (state) => ({
            schedules: state.scheduleManager.facts?.schedules ?? NO_SCHEDULES,
            onScreen: state.terminal.onScreen,
        }),
        shallowEqual,
    );
    const body = useRef<HTMLDivElement>(null);

    // The cached projects are outside the store (see `session-store`); the list is read as the dialog draws.
    const choices = localProjectChoices(view.cachedProjects, sessionRecency(view.cachedAllProjects));
    const onScreenPath = onScreen ? (sessionMap.get(onScreen)?.projectPath ?? null) : null;
    const projectPath = create.projectPath ?? defaultProjectPath(choices, onScreenPath);
    const review = create.step === 'review' && create.settings;

    // Into the dialog as it opens with nothing to type in yet (a session's draft), so Esc is its own.
    useEffect(() => {
        if (!body.current?.contains(document.activeElement)) body.current?.focus({preventScroll: true});
    }, [create.step]);

    const draft = (): void => {
        if (projectPath) void draftSchedule(create.sentence, projectPath);
    };
    const save = (runNow: boolean): void => {
        if (create.settings && !scheduleSettingsProblem(create.settings))
            void saveNewSchedule(create.settings, runNow, onClose);
    };
    const escape = (): void => {
        if (create.step === 'review' && create.busy !== 'saving') dispatch({type: 'scheduleCreateBack'});
        else onClose();
    };
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.key !== 'Enter' || e.altKey || e.ctrlKey || e.nativeEvent.isComposing) return;
        const target = e.target as HTMLElement;
        if (create.step === 'review') {
            if (!e.metaKey) return;
            e.preventDefault();
            save(false);
            return;
        }
        // Enter on a button is that button's own click; ⇧⏎ is a new line in the sentence.
        if (e.shiftKey || e.metaKey || target.matches('button, select') || create.fromSession) return;
        e.preventDefault();
        draft();
    };

    return (
        <DialogShell
            overlayClass="new-session-overlay"
            dialogClass="new-session-dialog schedule-create-dialog"
            onClose={onClose}
            onEscape={escape}
            trapFocus>
            <div
                ref={body}
                className="sc-body"
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="schedule-create-title"
                onKeyDown={onKeyDown}>
                {review ? (
                    <ReviewStep
                        settings={review}
                        whenReason={create.whenReason}
                        saving={create.busy === 'saving'}
                        error={create.error}
                        taken={takenSlugs(schedules, review.projectPath)}
                        onSave={save}
                    />
                ) : create.fromSession ? (
                    <FromSessionStep
                        sessionId={create.fromSession}
                        error={create.busy ? null : create.error}
                        projectPath={projectPath}
                        onClose={onClose}
                    />
                ) : (
                    <DescribeStep
                        sentence={create.sentence}
                        projectPath={projectPath}
                        choices={choices}
                        copies={copyChoices(schedules)}
                        drafting={create.busy === 'drafting'}
                        error={create.error}
                        onDraft={draft}
                        onClose={onClose}
                    />
                )}
            </div>
        </DialogShell>
    );
}

const NO_SCHEDULES: never[] = [];

interface DescribeStepProps {
    sentence: string;
    projectPath: string | null;
    choices: ReturnType<typeof localProjectChoices>;
    copies: ReturnType<typeof copyChoices>;
    drafting: boolean;
    error: string | null;
    onDraft(): void;
    onClose(): void;
}

function DescribeStep({
    sentence,
    projectPath,
    choices,
    copies,
    drafting,
    error,
    onDraft,
    onClose,
}: DescribeStepProps): JSX.Element {
    const canDraft = !!sentence.trim() && !!projectPath && !drafting;
    return (
        <>
            <h3 id="schedule-create-title">New schedule</h3>
            <label className="sc-label" htmlFor="schedule-create-sentence">
                What should it do, and when?
            </label>
            <textarea
                id="schedule-create-sentence"
                className="sc-sentence"
                rows={4}
                autoFocus
                readOnly={drafting}
                placeholder="Every night, look at new Bugsnag errors and open a PR for the worst ones. At most 3."
                value={sentence}
                onChange={(e) => dispatch({type: 'scheduleCreateSentenceTyped', text: e.target.value})}
            />
            <div className="sc-project">
                <label htmlFor="schedule-create-project">Project</label>
                {choices.length > 0 ? (
                    <select
                        id="schedule-create-project"
                        className="sf-select"
                        value={projectPath ?? ''}
                        disabled={drafting}
                        onChange={(e) => dispatch({type: 'scheduleCreateProjectPicked', projectPath: e.target.value})}>
                        {choices.map((choice) => (
                            <option key={choice.path} value={choice.path}>
                                {choice.label}
                            </option>
                        ))}
                    </select>
                ) : (
                    <span className="sf-note" id="schedule-create-project">
                        Add a project first: schedules run in one.
                    </span>
                )}
            </div>
            <div className="sc-starters">
                <span className="sf-note" id="schedule-create-starters">
                    Or start from one
                </span>
                <div className="sf-chips" role="group" aria-labelledby="schedule-create-starters">
                    {SCHEDULE_STARTERS.map((starter) => (
                        <button
                            key={starter.label}
                            type="button"
                            className="sf-chip"
                            disabled={drafting}
                            onClick={() => dispatch({type: 'scheduleCreateSentenceTyped', text: starter.sentence})}>
                            {starter.label}
                        </button>
                    ))}
                    {copies.map((copy) => (
                        <button
                            key={copy.key}
                            type="button"
                            className="sf-chip"
                            disabled={drafting}
                            onClick={() => copySchedule(copy.key)}>
                            {copy.label}
                        </button>
                    ))}
                </div>
            </div>
            {drafting && <Working text="Claude is drafting it. This usually takes 10 to 30 seconds." />}
            {error && !drafting && (
                <div className="handoff-error" role="alert">
                    {error}
                </div>
            )}
            <div className="new-session-actions">
                <button type="button" className="sc-ghost" onClick={onClose}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="new-session-cancel-btn"
                    disabled={!projectPath || drafting}
                    onClick={() => projectPath && writeScheduleYourself(projectPath)}>
                    Write it myself
                </button>
                <button type="button" className="new-session-start-btn" disabled={!canDraft} onClick={onDraft}>
                    Draft it <kbd aria-hidden="true">⏎</kbd>
                </button>
            </div>
        </>
    );
}

interface FromSessionStepProps {
    sessionId: string;
    error: string | null;
    projectPath: string | null;
    onClose(): void;
}

/** Make this a schedule: Claude drafts from the session; on a failure, try again or write it by hand. */
function FromSessionStep({sessionId, error, projectPath, onClose}: FromSessionStepProps): JSX.Element {
    const sessionProject = sessionMap.get(sessionId)?.projectPath ?? null;
    const project = sessionProject ? (worktreeParentPath(sessionProject) ?? sessionProject) : projectPath;
    return (
        <>
            <h3 id="schedule-create-title">Make this a schedule</h3>
            {project && <div className="handoff-project">{projectLabel(project)}</div>}
            {error ? (
                <div className="handoff-error" role="alert">
                    {error}
                </div>
            ) : (
                <Working text="Claude is turning what this session did into a prompt that stands on its own. This usually takes 10 to 30 seconds." />
            )}
            <div className="new-session-actions">
                <button type="button" className="sc-ghost" onClick={onClose}>
                    Cancel
                </button>
                {error && project && (
                    <button
                        type="button"
                        className="new-session-cancel-btn"
                        onClick={() => writeScheduleYourself(project)}>
                        Write it myself
                    </button>
                )}
                {error && (
                    <button
                        type="button"
                        className="new-session-start-btn"
                        onClick={() => void draftFromSession(sessionId)}>
                        Try again
                    </button>
                )}
            </div>
        </>
    );
}

interface ReviewStepProps {
    settings: ScheduleSettings;
    whenReason: string | null;
    saving: boolean;
    error: string | null;
    taken: ReadonlySet<string>;
    onSave(runNow: boolean): void;
}

function ReviewStep({settings, whenReason, saving, error, taken, onSave}: ReviewStepProps): JSX.Element {
    const problem = scheduleSettingsProblem(settings);
    return (
        <>
            <h3 id="schedule-create-title">Review the draft</h3>
            <div className="sc-form">
                <ScheduleForm
                    value={settings}
                    onChange={(next) =>
                        dispatch({type: 'scheduleCreateSettingsEdited', settings: withNewName(settings, next, taken)})
                    }
                    whenReason={whenReason}
                    withPrompt
                    autoFocusName
                />
            </div>
            {error && (
                <div className="handoff-error" role="alert">
                    {error}
                </div>
            )}
            <div className="sc-footer">
                <span className="sf-note sc-saves-to">
                    {problem ?? (
                        <>
                            Saves to <code>{scheduleFileHint(settings.slug)}</code> in{' '}
                            {projectLabel(settings.projectPath)}
                        </>
                    )}
                </span>
                <button
                    type="button"
                    className="sc-ghost"
                    disabled={saving}
                    onClick={() => dispatch({type: 'scheduleCreateBack'})}>
                    Back
                </button>
                <button
                    type="button"
                    className="new-session-cancel-btn"
                    disabled={saving || !!problem}
                    title="Runs it once now, so the first run is not at night with nobody watching"
                    onClick={() => onSave(true)}>
                    Save and try it now
                </button>
                <button
                    type="button"
                    className="new-session-start-btn"
                    disabled={saving || !!problem}
                    onClick={() => onSave(false)}>
                    {saving ? 'Saving…' : 'Save'} <kbd aria-hidden="true">⌘⏎</kbd>
                </button>
            </div>
        </>
    );
}

function Working({text}: {text: string}): JSX.Element {
    return (
        <div className="sc-working" role="status">
            <span className="freshness-spinner" aria-hidden="true" />
            {text}
        </div>
    );
}

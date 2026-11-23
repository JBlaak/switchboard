/**
 * A schedule's settings as a form: the create form's review step and a
 * schedule's page both edit them with it.
 *
 * - Name, and the prompt (monospace) when `withPrompt`.
 * - When: Nightly, Weekdays, Weekly (and its day), Hourly (and its minute) or
 *   Cron… (five fields, checked as typed); the time; the cron it comes to,
 *   small; why Claude picked it, for a draft; and what to do when the Mac
 *   slept through it.
 * - Where and how: a fresh worktree or the checkout, and the model.
 * - Permissions: the mode, the common tools as chips, and any other rules
 *   (an MCP tool, `Bash(git log:*)`) as free text.
 * - Limits: stop after N minutes, don't start past N% of the week.
 *
 * Controlled: every edit is a whole new `ScheduleSettings` through
 * `onChange`. The rules (presets, tools, slugs) are `domain/schedule`'s. The
 * form keeps two things of its own: that Cron… was picked (a hand-typed cron
 * that happens to read as a preset stays on Cron…), and the free tool text as
 * typed. Key it on the schedule when it can be handed another one.
 */
import {useId, useState} from 'react';
import type {JSX} from 'react';
import {
    SCHEDULE_PRESETS,
    WEEKDAY_NAMES,
    cronFromWhen,
    cronProblem,
    formatTime,
    whenFromCron,
    withPreset,
    withTime,
} from '../../../domain/schedule/presets';
import {
    SCHEDULE_MODELS,
    SCHEDULE_PERMISSION_MODES,
    SCHEDULE_TOOLS,
    joinAllowedTools,
    splitAllowedTools,
    toggleAllowedTool,
} from '../../../domain/schedule/form';
import type {SchedulePreset} from '../../../domain/schedule/presets';
import type {MissedPolicy, ScheduleSettings} from '../../../domain/schedule/manager';

export interface ScheduleFormProps {
    readonly value: ScheduleSettings;
    readonly onChange: (next: ScheduleSettings) => void;
    /** Why Claude picked that time, under the When row, for a draft. */
    readonly whenReason?: string | null;
    /** Whether the prompt is shown (the create form) or edited elsewhere (a schedule's page has its own prompt card). */
    readonly withPrompt: boolean;
    /** Put the focus in the Name field as the form appears. */
    readonly autoFocusName?: boolean;
}

export function ScheduleForm({value, onChange, whenReason, withPrompt, autoFocusName}: ScheduleFormProps): JSX.Element {
    const id = useId();
    const set = (part: Partial<ScheduleSettings>): void => onChange({...value, ...part});

    return (
        <div className="schedule-form">
            <div className="sf-name">
                <label htmlFor={id + 'name'}>Name</label>
                <input
                    id={id + 'name'}
                    className="sf-input sf-name-input"
                    value={value.name}
                    placeholder="Bugsnag sweep"
                    autoFocus={autoFocusName}
                    onChange={(e) => set({name: e.target.value})}
                />
            </div>

            {withPrompt && (
                <div className="sf-prompt">
                    <div className="sf-prompt-head">
                        <label htmlFor={id + 'prompt'}>Prompt</label>
                        <span className="sf-note" id={id + 'prompt-note'}>
                            runs with no one to ask: say what to skip, when to stop, and to end with a short report
                        </span>
                    </div>
                    <textarea
                        id={id + 'prompt'}
                        className="sf-input sf-prompt-input"
                        rows={9}
                        spellCheck={false}
                        aria-describedby={id + 'prompt-note'}
                        value={value.prompt}
                        onChange={(e) => set({prompt: e.target.value})}
                    />
                </div>
            )}

            <WhenSection id={id} value={value} set={set} whenReason={whenReason ?? null} />
            <HowSection id={id} value={value} set={set} />
            <PermissionsSection id={id} value={value} set={set} />
            <LimitsSection id={id} value={value} set={set} />
        </div>
    );
}

interface SectionProps {
    readonly id: string;
    readonly value: ScheduleSettings;
    readonly set: (part: Partial<ScheduleSettings>) => void;
}

function WhenSection({id, value, set, whenReason}: SectionProps & {whenReason: string | null}): JSX.Element {
    const when = whenFromCron(value.cron);
    const [raw, setRaw] = useState(when.preset === 'cron');
    const preset: SchedulePreset = raw ? 'cron' : when.preset;
    const problem = cronProblem(value.cron);

    const pick = (next: SchedulePreset): void => {
        setRaw(next === 'cron');
        if (next !== 'cron') set({cron: withPreset({...when, preset}, next).cron});
    };

    return (
        <section className="sf-section" aria-labelledby={id + 'when'}>
            <h4 className="sf-section-title" id={id + 'when'}>
                When
            </h4>
            <div className="sf-chips" role="group" aria-label="How often">
                {SCHEDULE_PRESETS.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        className={'sf-chip' + (preset === option.value ? ' is-on' : '')}
                        aria-pressed={preset === option.value}
                        onClick={() => pick(option.value)}>
                        {option.label}
                    </button>
                ))}
            </div>

            <div className="sf-line">
                {preset === 'weekly' && (
                    <>
                        <label htmlFor={id + 'day'}>on</label>
                        <select
                            id={id + 'day'}
                            className="sf-select"
                            value={when.day}
                            onChange={(e) => set({cron: cronFromWhen({...when, day: Number(e.target.value)})})}>
                            {WEEKDAY_NAMES.map((day, n) => (
                                <option key={day} value={n}>
                                    {day}
                                </option>
                            ))}
                        </select>
                    </>
                )}
                {(preset === 'nightly' || preset === 'weekdays' || preset === 'weekly') && (
                    <>
                        <label htmlFor={id + 'at'}>at</label>
                        <input
                            id={id + 'at'}
                            type="time"
                            className="sf-input sf-time"
                            value={formatTime(when.hour, when.minute)}
                            onChange={(e) => set({cron: withTime(when, e.target.value).cron})}
                        />
                    </>
                )}
                {preset === 'hourly' && (
                    <>
                        <label htmlFor={id + 'minute'}>at minute</label>
                        <input
                            id={id + 'minute'}
                            type="number"
                            min={0}
                            max={59}
                            className="sf-input sf-number"
                            value={when.minute}
                            onChange={(e) => {
                                const minute = Number(e.target.value);
                                if (Number.isInteger(minute) && minute >= 0 && minute <= 59)
                                    set({cron: cronFromWhen({...when, minute})});
                            }}
                        />
                    </>
                )}
                {preset === 'cron' && (
                    <>
                        <label htmlFor={id + 'cron'}>Cron</label>
                        <input
                            id={id + 'cron'}
                            className="sf-input sf-cron"
                            value={value.cron}
                            spellCheck={false}
                            placeholder="0 3 * * *"
                            aria-invalid={problem !== null}
                            aria-describedby={id + 'cron-help'}
                            onChange={(e) => set({cron: e.target.value})}
                        />
                    </>
                )}
                {preset !== 'cron' && (
                    <code className="sf-cron-shown" aria-label={'Cron ' + value.cron}>
                        {value.cron}
                    </code>
                )}
            </div>
            {preset === 'cron' && (
                <div className={'sf-note' + (problem ? ' is-problem' : '')} id={id + 'cron-help'}>
                    {problem ?? 'minute · hour · day of the month · month · weekday, in local time'}
                </div>
            )}
            {whenReason && <div className="sf-note sf-reason">{whenReason}</div>}

            <div className="sf-line">
                <label htmlFor={id + 'missed'}>If the Mac slept through it</label>
                <select
                    id={id + 'missed'}
                    className="sf-select"
                    value={value.missed}
                    onChange={(e) => set({missed: e.target.value as MissedPolicy})}>
                    <option value="run-once">Run once when it wakes</option>
                    <option value="skip">Skip it</option>
                </select>
            </div>
        </section>
    );
}

function HowSection({id, value, set}: SectionProps): JSX.Element {
    const models = withCurrent(SCHEDULE_MODELS, value.model);
    return (
        <section className="sf-section" aria-labelledby={id + 'how'}>
            <h4 className="sf-section-title" id={id + 'how'}>
                Where and how
            </h4>
            <label className="sf-check">
                <input type="checkbox" checked={value.worktree} onChange={(e) => set({worktree: e.target.checked})} />
                Works in a fresh worktree off the default branch
            </label>
            <div className="sf-line">
                <label htmlFor={id + 'model'}>Model</label>
                <select
                    id={id + 'model'}
                    className="sf-select"
                    value={value.model ?? ''}
                    onChange={(e) => set({model: e.target.value || null})}>
                    {models.map((model) => (
                        <option key={model.value ?? ''} value={model.value ?? ''}>
                            {model.label}
                        </option>
                    ))}
                </select>
            </div>
        </section>
    );
}

function PermissionsSection({id, value, set}: SectionProps): JSX.Element {
    const split = splitAllowedTools(value.allowedTools);
    // The free text as typed: joining it on every key would eat a comma before the next rule is written.
    const [extra, setExtra] = useState(split.extra);
    const modes = withCurrent(SCHEDULE_PERMISSION_MODES, value.permissionMode);
    return (
        <section className="sf-section" aria-labelledby={id + 'permissions'}>
            <h4 className="sf-section-title" id={id + 'permissions'}>
                Permissions
            </h4>
            <div className="sf-line">
                <label htmlFor={id + 'mode'}>Mode</label>
                <select
                    id={id + 'mode'}
                    className="sf-select"
                    value={value.permissionMode}
                    onChange={(e) => set({permissionMode: e.target.value})}>
                    {modes.map((mode) => (
                        <option key={mode.value} value={mode.value ?? ''}>
                            {mode.label}
                        </option>
                    ))}
                </select>
            </div>
            <div className="sf-chips" role="group" aria-label="Allowed tools">
                {SCHEDULE_TOOLS.map((tool) => {
                    const on = split.tools.includes(tool);
                    return (
                        <button
                            key={tool}
                            type="button"
                            className={'sf-chip sf-tool' + (on ? ' is-on' : '')}
                            aria-pressed={on}
                            onClick={() => set({allowedTools: toggleAllowedTool(value.allowedTools, tool)})}>
                            {tool}
                        </button>
                    );
                })}
            </div>
            <div className="sf-line">
                <label htmlFor={id + 'extra'}>Other tools</label>
                <input
                    id={id + 'extra'}
                    className="sf-input sf-extra"
                    value={extra}
                    spellCheck={false}
                    placeholder="mcp__bugsnag__list_errors, Bash(gh pr:*)"
                    onChange={(e) => {
                        setExtra(e.target.value);
                        set({allowedTools: joinAllowedTools(split.tools, e.target.value)});
                    }}
                />
            </div>
        </section>
    );
}

function LimitsSection({id, value, set}: SectionProps): JSX.Element {
    return (
        <section className="sf-section" aria-labelledby={id + 'limits'}>
            <h4 className="sf-section-title" id={id + 'limits'}>
                Limits
            </h4>
            <div className="sf-line">
                <label htmlFor={id + 'minutes'}>Stop after</label>
                <input
                    id={id + 'minutes'}
                    type="number"
                    min={1}
                    className="sf-input sf-number"
                    placeholder="—"
                    value={value.limitMinutes ?? ''}
                    onChange={(e) => set({limitMinutes: numberOrNull(e.target.value)})}
                />
                <span>minutes</span>
            </div>
            <div className="sf-line">
                <label htmlFor={id + 'week'}>Don&apos;t start past</label>
                <input
                    id={id + 'week'}
                    type="number"
                    min={1}
                    max={100}
                    className="sf-input sf-number"
                    placeholder="—"
                    value={value.weekCap ?? ''}
                    onChange={(e) => set({weekCap: numberOrNull(e.target.value)})}
                />
                <span>% of the week</span>
            </div>
            <div className="sf-note">
                Leave one empty for no limit. Runs use your own subscription, like your sessions.
            </div>
        </section>
    );
}

/** The options, with the current value added when it is not one of them (set in the file by hand). */
function withCurrent<T extends string | null>(
    options: readonly {readonly value: T; readonly label: string}[],
    current: T,
): readonly {readonly value: T; readonly label: string}[] {
    return options.some((option) => option.value === current)
        ? options
        : [...options, {value: current, label: String(current)}];
}

function numberOrNull(text: string): number | null {
    if (text.trim() === '') return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
}

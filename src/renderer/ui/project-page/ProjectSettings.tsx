/**
 * A project's settings on its page (#176): the route `project → settings`.
 *
 * A breadcrumb back to the overview (‹ project / Settings, ⌘[), then the
 * launch settings a project can override, grouped as Starting Claude and
 * Environment, and the Project group with Hide. Every field shows the value
 * a session in the project would launch with and says whether that overrides
 * the global default; "Reset to global settings" drops every override.
 *
 * Each change is stored as it is made: a switch or a mode on click, a text
 * field when it loses focus, on Enter, or when the view closes with an edit
 * in it. Esc closes the page, back to the session it covered.
 *
 * A VM project (#276) has a This VM group too: the host's instructions, the
 * config copy switch and the base folder for copies. They are the host's, kept
 * on its agent, and saved there the same way; a host that can't be reached
 * says so in place of the form.
 */
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {JSX, KeyboardEvent, ReactNode} from 'react';
import {useStore} from '../use-store';
import {projectLabel} from '../../features/sessions/project-label';
import {
    describeSettingValue,
    hasOverrides,
    permissionModeChoices,
    projectFieldStates,
} from '../../../domain/settings/project-overrides';
import {backToProject, closeProject, isRemoteProject} from './actions';
import {changeProjectSetting, hideProjectFromPage, resetProjectSettings} from './settings-actions';
import {loadHostSettings, saveHostSettings} from './agent-actions';
import {hostViewIn, isVmProjectIn} from '../../state/agent-host-slice';
import type {ProjectFieldState, ProjectSettingField} from '../../../domain/settings/project-overrides';

export function ProjectSettings({projectPath}: {projectPath: string}): JSX.Element {
    const view = useStore((state) =>
        state.settings.project?.projectPath === projectPath ? state.settings.project : null,
    );
    const root = useRef<HTMLDivElement>(null);
    const name = projectLabel(projectPath);

    // Into the view as it opens, so ⌘[ and Esc reach it without a click.
    useLayoutEffect(() => {
        root.current?.focus({preventScroll: true});
    }, [projectPath]);

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'BracketLeft') {
            e.preventDefault();
            backToProject();
            return;
        }
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if ((e.target as HTMLElement).matches('input, textarea, select, [contenteditable="true"]')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeProject();
        }
    };

    return (
        <div
            ref={root}
            className="sw-page project-settings"
            tabIndex={-1}
            role="region"
            aria-label={'Settings for ' + name}
            onKeyDown={onKeyDown}>
            <header className="sw-header pp-crumbs-header ps-header">
                <nav className="pp-crumbs" aria-label="Breadcrumb">
                    <button
                        type="button"
                        className="pp-crumb"
                        onClick={backToProject}
                        aria-label={'Back to ' + name + ' (⌘[)'}>
                        <svg
                            width="13"
                            height="13"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true">
                            <path d="m15 6-6 6 6 6" />
                        </svg>
                        {name}
                    </button>
                    <span className="pp-crumb-sep" aria-hidden="true">
                        /
                    </span>
                    <span className="pp-crumb-here" aria-current="page">
                        Settings
                    </span>
                    <kbd className="sw-kbd">⌘[</kbd>
                    <span className="ps-saved" role="status">
                        {view?.saved && (
                            <>
                                <svg
                                    width="13"
                                    height="13"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true">
                                    <path d="m5 12 5 5 9-10" />
                                </svg>
                                Saved · applies to new sessions
                            </>
                        )}
                    </span>
                </nav>
                <h1 className="sw-title ps-title">Settings · {name}</h1>
            </header>
            <div className="ps-body">
                {view && (
                    <SettingsFields
                        projectPath={projectPath}
                        fields={projectFieldStates(view.globalSettings, view.current)}
                        canReset={hasOverrides(view.globalSettings, view.current)}
                    />
                )}
            </div>
        </div>
    );
}

interface FieldsProps {
    projectPath: string;
    fields: Readonly<Record<ProjectSettingField, ProjectFieldState>>;
    canReset: boolean;
}

function SettingsFields({projectPath, fields, canReset}: FieldsProps): JSX.Element {
    const change = (field: ProjectSettingField) => (value: unknown) =>
        void changeProjectSetting(projectPath, field, value);
    const mode = fields.permissionMode;
    const vm = useStore((state) => isVmProjectIn(state.agentHost, projectPath));
    return (
        <div className="ps-form">
            <section className="ps-section" aria-labelledby="ps-starting">
                <h2 className="ps-section-title" id="ps-starting">
                    Starting Claude
                </h2>
                <div className="ps-group">
                    <Field
                        label="Permission mode"
                        help="How Claude asks before it acts."
                        field="permissionMode"
                        state={mode}>
                        <div className="ps-seg" role="radiogroup" aria-label="Permission mode">
                            {permissionModeChoices(mode.value).map((choice) => (
                                <button
                                    key={choice.value ?? 'default'}
                                    type="button"
                                    role="radio"
                                    aria-checked={mode.value === choice.value}
                                    className={mode.value === choice.value ? 'is-on' : undefined}
                                    onClick={() => change('permissionMode')(choice.value)}>
                                    {choice.label}
                                </button>
                            ))}
                        </div>
                    </Field>
                    <Field
                        label="Skip permission prompts"
                        help={
                            <span className="ps-danger">
                                --dangerously-skip-permissions. Claude runs every tool without asking.
                            </span>
                        }
                        field="dangerouslySkipPermissions"
                        state={fields.dangerouslySkipPermissions}>
                        <Switch
                            label="Skip permission prompts"
                            on={!!fields.dangerouslySkipPermissions.value}
                            onChange={change('dangerouslySkipPermissions')}
                        />
                    </Field>
                    <Field
                        label="Start new sessions in a worktree"
                        help="Each session gets its own checkout under .claude/worktrees/."
                        field="worktree"
                        state={fields.worktree}>
                        <Switch
                            label="Start new sessions in a worktree"
                            on={!!fields.worktree.value}
                            onChange={change('worktree')}
                        />
                    </Field>
                    <Field
                        label="Chrome"
                        help="Let Claude drive a browser with --chrome."
                        field="chrome"
                        state={fields.chrome}>
                        <Switch label="Chrome" on={!!fields.chrome.value} onChange={change('chrome')} />
                    </Field>
                </div>
            </section>

            <section className="ps-section" aria-labelledby="ps-environment">
                <h2 className="ps-section-title" id="ps-environment">
                    Environment
                </h2>
                <div className="ps-group">
                    <Field
                        label="Before Claude starts"
                        help="Put in front of the claude command, to load credentials or a toolchain first."
                        field="preLaunchCmd"
                        state={fields.preLaunchCmd}
                        inputId="ps-pre-launch">
                        <TextSetting
                            id="ps-pre-launch"
                            value={String(fields.preLaunchCmd.value ?? '')}
                            placeholder="e.g. aws-vault exec profile --"
                            onCommit={change('preLaunchCmd')}
                        />
                    </Field>
                    <Field
                        label="Extra directories"
                        help="Passed as --add-dir, separated by commas."
                        field="addDirs"
                        state={fields.addDirs}
                        inputId="ps-add-dirs">
                        <TextSetting
                            id="ps-add-dirs"
                            value={String(fields.addDirs.value ?? '')}
                            placeholder="/path/to/dir1, /path/to/dir2"
                            onCommit={change('addDirs')}
                        />
                    </Field>
                </div>
                <div className="ps-reset-row">
                    <button
                        type="button"
                        className="ps-reset"
                        disabled={!canReset}
                        onClick={() => void resetProjectSettings(projectPath)}>
                        Reset to global settings
                    </button>
                </div>
            </section>

            {vm && <ThisVmSection projectPath={projectPath} />}

            {!isRemoteProject(projectPath) && (
                <section className="ps-section" aria-labelledby="ps-project">
                    <h2 className="ps-section-title" id="ps-project">
                        Project
                    </h2>
                    <div className="ps-group">
                        <div className="ps-field">
                            <div className="ps-field-text">
                                <span className="ps-label">Hide from the sidebar</span>
                                <div className="ps-help">
                                    Its sessions leave the list. Session files stay on disk; add the folder again to
                                    bring it back.
                                </div>
                            </div>
                            <button
                                type="button"
                                className="sw-btn"
                                onClick={() => void hideProjectFromPage(projectPath)}>
                                Hide project
                            </button>
                        </div>
                    </div>
                </section>
            )}
        </div>
    );
}

/** The host's own settings, on its agent: what every launch there is told, the config copy and where copies go. */
function ThisVmSection({projectPath}: {projectPath: string}): JSX.Element {
    const settings = useStore((state) => hostViewIn(state.agentHost, projectPath).settings);

    useEffect(() => {
        void loadHostSettings(projectPath);
    }, [projectPath]);

    return (
        <section className="ps-section" aria-labelledby="ps-vm">
            <h2 className="ps-section-title" id="ps-vm">
                This VM
            </h2>
            {(!settings || settings.phase === 'loading') && (
                <div className="ps-group">
                    <div className="ps-field ps-vm-note">Reading the VM’s settings…</div>
                </div>
            )}
            {settings?.phase === 'unreachable' && (
                <div className="ps-group">
                    <div className="ps-field ps-vm-note" role="status">
                        <div className="ps-field-text">
                            <span className="ps-label">Couldn’t reach the VM</span>
                            <div className="ps-help">
                                Its settings are kept on the VM, so they show once it answers.
                            </div>
                        </div>
                        <button type="button" className="sw-btn" onClick={() => void loadHostSettings(projectPath)}>
                            Try again
                        </button>
                    </div>
                </div>
            )}
            {settings?.phase === 'ok' && (
                <div className="ps-group">
                    <div className="ps-field ps-field-stacked">
                        <div className="ps-field-text">
                            <label className="ps-label" htmlFor="ps-vm-instructions">
                                Host instructions
                            </label>
                            <div className="ps-help">
                                Every Claude session on this VM is told this, after the project’s own instructions.
                            </div>
                        </div>
                        <TextAreaSetting
                            id="ps-vm-instructions"
                            value={settings.settings.instructions}
                            onCommit={(instructions) => void saveHostSettings(projectPath, {instructions})}
                        />
                    </div>
                    <div className="ps-field">
                        <div className="ps-field-text">
                            <span className="ps-label">Copy my Claude config to this VM</span>
                            <div className="ps-help">
                                Your CLAUDE.md, skills, commands, agents and plugins, on every connect. Never your
                                credentials.
                            </div>
                        </div>
                        <Switch
                            label="Copy my Claude config to this VM"
                            on={settings.settings.copyConfig}
                            onChange={(copyConfig) => void saveHostSettings(projectPath, {copyConfig})}
                        />
                    </div>
                    <div className="ps-field">
                        <div className="ps-field-text">
                            <label className="ps-label" htmlFor="ps-vm-base-folder">
                                Base folder for copies
                            </label>
                            <div className="ps-help">Where projects handed off to this VM are put.</div>
                        </div>
                        <TextSetting
                            id="ps-vm-base-folder"
                            value={settings.settings.baseFolder}
                            placeholder="~/projects"
                            onCommit={(baseFolder) => void saveHostSettings(projectPath, {baseFolder})}
                        />
                    </div>
                    {settings.saveError && (
                        <div className="ps-field ps-vm-error" role="alert">
                            {settings.saveError}
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}

interface FieldProps {
    label: string;
    help: ReactNode;
    field: ProjectSettingField;
    state: ProjectFieldState;
    /** A text field's input, which the label names. */
    inputId?: string;
    children: ReactNode;
}

/** One row: the label, its help and whether it overrides the global default, then the control. */
function Field({label, help, field, state, inputId, children}: FieldProps): JSX.Element {
    return (
        <div className="ps-field">
            <div className="ps-field-text">
                {inputId ? (
                    <label className="ps-label" htmlFor={inputId}>
                        {label}
                    </label>
                ) : (
                    <span className="ps-label">{label}</span>
                )}
                <div className="ps-help">
                    {help}{' '}
                    <span className={state.overrides ? 'ps-inherit is-override' : 'ps-inherit'}>
                        {state.overrides
                            ? `Overrides the global default (${describeSettingValue(field, state.globalValue)}).`
                            : 'Same as global.'}
                    </span>
                </div>
            </div>
            {children}
        </div>
    );
}

function Switch({label, on, onChange}: {label: string; on: boolean; onChange(value: boolean): void}): JSX.Element {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            className={on ? 'ps-switch is-on' : 'ps-switch'}
            onClick={() => onChange(!on)}>
            <span />
        </button>
    );
}

interface TextSettingProps {
    id: string;
    value: string;
    placeholder: string;
    onCommit(value: string): void;
}

/**
 * A text setting, stored when it loses focus, on Enter, or when the view
 * closes with an edit in it — not on every key, so a half-typed command is
 * never what a session launches with.
 */
function TextSetting({id, value, placeholder, onCommit}: TextSettingProps): JSX.Element {
    const [draft, setDraft] = useState(value);
    const latest = useRef({draft, value, onCommit});
    latest.current = {draft, value, onCommit};

    // A reset, or the read landing, puts the stored value back in the box.
    useEffect(() => setDraft(value), [value]);

    useEffect(
        () => () => {
            const {draft: pending, value: stored, onCommit: commit} = latest.current;
            if (pending.trim() !== stored.trim()) commit(pending);
        },
        [],
    );

    const commit = (): void => {
        if (draft.trim() !== value.trim()) onCommit(draft);
    };

    return (
        <input
            id={id}
            type="text"
            className="ps-input"
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
            }}
        />
    );
}

/**
 * A long text setting, stored when it loses focus or when the view closes
 * with an edit in it. Enter is a new line here, not a save.
 */
function TextAreaSetting({
    id,
    value,
    onCommit,
}: {
    id: string;
    value: string;
    onCommit(value: string): void;
}): JSX.Element {
    const [draft, setDraft] = useState(value);
    const latest = useRef({draft, value, onCommit});
    latest.current = {draft, value, onCommit};

    useEffect(() => setDraft(value), [value]);

    useEffect(
        () => () => {
            const {draft: pending, value: stored, onCommit: commit} = latest.current;
            if (pending !== stored) commit(pending);
        },
        [],
    );

    return (
        <textarea
            id={id}
            className="ps-input ps-textarea"
            value={draft}
            rows={6}
            spellCheck={false}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onBlur={() => {
                if (draft !== value) onCommit(draft);
            }}
        />
    );
}

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
 * A VM project (#276) has a This VM group too, which points to the VM in
 * Settings → VMs (#307): the host's instructions, the config copy switch and
 * the base folder are the VM's, shared by every project on it, so they are
 * set there.
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
import {
    changeProjectSetting,
    readReleaseTags,
    resetProjectSettings,
    setReleasesTagged,
    setWatchIssues,
} from './settings-actions';
import {releasesTaggedOverride, resolveWatchIssues} from '../../../domain/settings/inbox-settings';
import {releaseTagsHelp} from './release-tags-view';
import type {ReleaseTagsView} from '../../../application/services/inbox-settings-service';
import type {SettingsRecord} from '../../state/settings-slice';
import {hideProjectFromPage} from './hide-project';
import {isVmProjectIn} from '../../state/agent-host-slice';
import {CommitText} from '../settings/CommitInputs';
import {hostLinkOf} from '../vms/vm-hosts';
import {openVmSettings} from '../vms/open-settings';
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
                        current={view.current}
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
    /** The project's own blob, for the settings that are not launch overrides. */
    current: SettingsRecord;
    fields: Readonly<Record<ProjectSettingField, ProjectFieldState>>;
    canReset: boolean;
}

function SettingsFields({projectPath, current, fields, canReset}: FieldsProps): JSX.Element {
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

            {(vm || !isRemoteProject(projectPath)) && <InboxSection projectPath={projectPath} current={current} />}

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

/**
 * Inbox (#412): what the managers on the empty screen read from the
 * project. Watch issues puts its loose issues in the Issue manager; Releases
 * are tagged follows the project's tags unless it is set to Tagged or Not
 * tagged. Neither is a launch setting, so neither has a global default.
 */
function InboxSection({projectPath, current}: {projectPath: string; current: SettingsRecord}): JSX.Element {
    const watching = resolveWatchIssues(current);
    const override = releasesTaggedOverride(current);
    const [tags, setTags] = useState<ReleaseTagsView | null | undefined>(undefined);
    useEffect(() => {
        let live = true;
        setTags(undefined);
        void readReleaseTags(projectPath).then((answer) => {
            if (live) setTags(answer);
        });
        return () => {
            live = false;
        };
    }, [projectPath]);
    const choices: {value: boolean | null; label: string}[] = [
        {value: null, label: 'Detect'},
        {value: true, label: 'Tagged'},
        {value: false, label: 'Not tagged'},
    ];
    return (
        <section className="ps-section" aria-labelledby="ps-inbox">
            <h2 className="ps-section-title" id="ps-inbox">
                Inbox
            </h2>
            <div className="ps-group">
                <div className="ps-field">
                    <div className="ps-field-text">
                        <span className="ps-label">Watch issues</span>
                        <div className="ps-help">
                            The Issue manager lists this project’s loose issues that are unassigned or assigned to you.
                        </div>
                    </div>
                    <Switch
                        label="Watch issues"
                        on={watching}
                        onChange={(on) => void setWatchIssues(projectPath, on)}
                    />
                </div>
                <div className="ps-field">
                    <div className="ps-field-text">
                        <span className="ps-label">Releases are tagged</span>
                        <div className="ps-help">
                            The Bug manager compares events after a fix with the first tag that contains it.{' '}
                            <span className="ps-inherit">{releaseTagsHelp(tags)}</span>
                        </div>
                    </div>
                    <div className="ps-seg" role="radiogroup" aria-label="Releases are tagged">
                        {choices.map((choice) => (
                            <button
                                key={String(choice.value)}
                                type="button"
                                role="radio"
                                aria-checked={override === choice.value}
                                className={override === choice.value ? 'is-on' : undefined}
                                onClick={() => void setReleasesTagged(projectPath, choice.value)}>
                                {choice.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </section>
    );
}

/** This VM: its settings are the VM's, in Settings → VMs. */
function ThisVmSection({projectPath}: {projectPath: string}): JSX.Element | null {
    const link = useStore((state) => hostLinkOf(projectPath, true, state.vms.hosts));
    if (link?.kind !== 'vm') return null;
    return (
        <section className="ps-section" aria-labelledby="ps-vm">
            <h2 className="ps-section-title" id="ps-vm">
                This VM
            </h2>
            <div className="ps-group">
                <div className="ps-field">
                    <div className="ps-field-text">
                        <span className="ps-label">On {link.label}</span>
                        <div className="ps-help">
                            Its host instructions, config copy and base folder are the VM’s, shared by every project on
                            it. They are in Settings.
                        </div>
                    </div>
                    <button type="button" className="sw-btn" onClick={() => void openVmSettings(link.key)}>
                        Manage in Settings
                    </button>
                </div>
            </div>
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

/** A text setting, stored as it is left (`CommitText`). */
function TextSetting(props: TextSettingProps): JSX.Element {
    return <CommitText className="ps-input" {...props} />;
}

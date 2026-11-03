/**
 * A VM's controls, under its row in Settings → VMs (#307):
 *
 * - The agent: Install agent on a VM with none yet, Update agent while it
 *   isn't the app's version. While it runs the button waits and the progress
 *   lines show; a failure shows its message and Retry.
 * - Setup, once there is an agent: a check per tool (installed with its
 *   version, and signed in), Check again, and Open setup terminal, which
 *   opens the shell setup runs in like any session.
 * - The host's settings, kept on its agent: the instructions every session
 *   there is told, the config copy switch and the base folder for copies. A
 *   VM that can't be reached says so in place of the form.
 * - Its name, and Remove.
 *
 * These moved here from the project pages (#276), keyed by the VM rather
 * than by one of its projects.
 */
import {useEffect} from 'react';
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {AppField} from '../settings/SettingsField';
import {CommitText, CommitTextArea} from '../settings/CommitInputs';
import {hostViewIn} from '../../state/agent-host-slice';
import {vmFailureIn} from '../../state/vms-slice';
import {INSTALL_HELP, installView, offersUpdate, setupDone, toolLines} from './agent-host-view';
import {
    installAgent,
    loadHostSettings,
    openAgentSetupTerminal,
    refreshAgentTools,
    saveHostSettings,
    updateAgent,
} from './agent-actions';
import {removeVm, renameVm} from './actions';
import {vmAddress, vmSlug} from './vm-hosts';
import {vmFailureLine} from './vms-copy';
import type {AgentHostView} from '../../state/agent-host-slice';
import type {InstallView} from './agent-host-view';
import type {VmHostView} from './vm-api';

export function VmControls({vm}: {vm: VmHostView}): JSX.Element {
    const host = useStore((s) => hostViewIn(s.agentHost, vm.key));
    const installed = vm.agent !== null;

    // Asked as the VM opens, and again once an install gives it an agent.
    useEffect(() => {
        if (!installed) return;
        void refreshAgentTools(vm.key);
        void loadHostSettings(vm.key);
    }, [vm.key, installed]);

    return (
        <div className="vm-controls">
            <AgentPart vm={vm} host={host} />
            {installed && <SetupPart vm={vm} host={host} />}
            {installed && <HostSettingsPart vm={vm} host={host} />}
            <NamePart vm={vm} />
        </div>
    );
}

function AgentPart({vm, host}: {vm: VmHostView; host: AgentHostView}): JSX.Element {
    const update = offersUpdate(vm);
    const view = installView(host.install, vm.agent === null ? 'Install agent' : 'Update agent');
    const phase = host.install.phase;
    const offered = vm.agent === null || update || phase === 'running' || phase === 'failed';
    const description =
        vm.agent === null
            ? INSTALL_HELP
            : update
              ? `Agent ${vm.agent} runs here; this app has a newer one. Updating restarts the agent, which ends every session on the VM.`
              : `Agent ${vm.agent}, this app’s version.`;
    const press = (): void => {
        void (phase === 'failed' || vm.agent === null ? installAgent(vm.key) : updateAgent(vm.key));
    };
    return (
        <>
            <AppField label="Switchboard agent" description={description}>
                {offered && (
                    <button
                        type="button"
                        className={'pa-btn' + (vm.agent === null ? ' vm-btn-primary' : '')}
                        disabled={view.disabled}
                        onClick={press}>
                        {view.label}
                    </button>
                )}
            </AppField>
            {phase !== 'idle' && <InstallProgress view={view} />}
        </>
    );
}

function SetupPart({vm, host}: {vm: VmHostView; host: AgentHostView}): JSX.Element {
    const tools = host.tools;
    return (
        <div className="settings-field vm-setup">
            <div className="settings-field-info">
                <span className="settings-label">
                    Setup
                    {tools?.phase === 'ok' && setupDone(tools.tools) && <span className="vm-ready">Ready</span>}
                </span>
                <div className="vm-tools" aria-busy={!tools || tools.phase === 'loading'}>
                    {(!tools || tools.phase === 'loading') && (
                        <div className="settings-description">Checking the VM…</div>
                    )}
                    {tools?.phase === 'unreachable' && (
                        <div className="settings-description" role="status">
                            Couldn’t reach the VM.
                        </div>
                    )}
                    {tools?.phase === 'ok' &&
                        toolLines(tools.tools).map((line) => (
                            <div key={line.tool} className={'pp-tool is-' + line.state}>
                                <span className="pp-tool-mark" aria-hidden="true">
                                    {line.state === 'ready' ? '✓' : line.state === 'missing' ? '–' : '!'}
                                </span>
                                <span className="pp-tool-name pp-mono">{line.tool}</span>
                                <span className="pp-tool-text">{line.text}</span>
                            </div>
                        ))}
                </div>
                <div className="vm-actions">
                    <button type="button" className="pa-btn" onClick={() => void openAgentSetupTerminal(vm.key)}>
                        Open setup terminal
                    </button>
                    <button type="button" className="pa-btn" onClick={() => void refreshAgentTools(vm.key)}>
                        Check again
                    </button>
                </div>
                {host.setupError && (
                    <div className="pa-error" role="alert">
                        {host.setupError}
                    </div>
                )}
            </div>
        </div>
    );
}

function HostSettingsPart({vm, host}: {vm: VmHostView; host: AgentHostView}): JSX.Element {
    const settings = host.settings;
    const id = (name: string) => `sv-vm-${name}-${vmSlug(vm.key)}`;

    if (!settings || settings.phase === 'loading') {
        return <AppField label="Host settings" description="Reading the VM’s settings…" />;
    }
    if (settings.phase === 'unreachable') {
        return (
            <AppField
                label="Couldn’t reach the VM"
                description="Its settings are kept on the VM, so they show once it answers.">
                <button type="button" className="pa-btn" onClick={() => void loadHostSettings(vm.key)}>
                    Try again
                </button>
            </AppField>
        );
    }
    return (
        <>
            <div className="settings-field settings-field-wide">
                <div className="settings-field-info">
                    <label className="settings-label" htmlFor={id('instructions')}>
                        Host instructions
                    </label>
                    <div className="settings-description">
                        Every Claude session on this VM is told this, after the project’s own instructions.
                    </div>
                </div>
                <CommitTextArea
                    id={id('instructions')}
                    className="settings-input vm-textarea"
                    value={settings.settings.instructions}
                    onCommit={(instructions) => void saveHostSettings(vm.key, {instructions})}
                />
            </div>
            <AppField
                label="Copy my Claude config to this VM"
                description="Your CLAUDE.md, skills, commands, agents and plugins, on every connect. Never your credentials.">
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        aria-label="Copy my Claude config to this VM"
                        checked={settings.settings.copyConfig}
                        onChange={(e) => void saveHostSettings(vm.key, {copyConfig: e.currentTarget.checked})}
                    />
                    <span className="settings-toggle-slider"></span>
                </label>
            </AppField>
            <AppField label="Base folder for copies" description="Where projects handed off to this VM are put.">
                <CommitText
                    id={id('base-folder')}
                    className="settings-input vm-input"
                    label="Base folder for copies"
                    value={settings.settings.baseFolder}
                    placeholder="~/projects"
                    onCommit={(baseFolder) => void saveHostSettings(vm.key, {baseFolder})}
                />
            </AppField>
            {settings.saveError && (
                <div className="pa-error" role="alert">
                    {settings.saveError}
                </div>
            )}
        </>
    );
}

function NamePart({vm}: {vm: VmHostView}): JSX.Element {
    const address = vmAddress(vm);
    const named = vm.label !== address;
    return (
        <>
            <AppField label="Name" description={`What this VM is called here. Empty, it goes by ${address}.`}>
                <CommitText
                    id={`sv-vm-name-${vmSlug(vm.key)}`}
                    className="settings-input vm-input"
                    label={`Rename ${vm.label}`}
                    value={named ? vm.label : ''}
                    placeholder={address}
                    onCommit={(name) => void renameVm(vm.key, name)}
                />
            </AppField>
            <CallFailure call="rename" />
            <AppField
                label="Remove this VM"
                description="Its projects leave the list here. The agent and its sessions keep running on the VM.">
                <button
                    type="button"
                    className="pa-btn pa-btn-danger"
                    aria-label={`Remove ${vm.label}`}
                    onClick={() => void removeVm(vm)}>
                    Remove…
                </button>
            </AppField>
            <CallFailure call="remove" />
        </>
    );
}

/** The install's progress lines, and why it failed. */
function InstallProgress({view}: {view: InstallView}): JSX.Element | null {
    if (view.lines.length === 0 && !view.error) return null;
    return (
        <div className="vm-progress">
            {view.lines.length > 0 && (
                <pre className="pp-agent-log" aria-live="polite">
                    {view.lines.join('\n')}
                </pre>
            )}
            {view.error && (
                <div className="pa-error" role="alert">
                    {view.error}
                </div>
            )}
        </div>
    );
}

/** Why a change to a VM didn't land. */
function CallFailure({call}: {call: 'rename' | 'remove'}): JSX.Element | null {
    const failure = useStore((s) => vmFailureIn(s.vms, call));
    if (failure === null) return null;
    return (
        <div className="pa-error" role="alert">
            {vmFailureLine(call, failure)}
        </div>
    );
}

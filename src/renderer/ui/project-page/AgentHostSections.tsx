/**
 * The project page's VM parts (#276), under a remote project's sessions.
 *
 * - On an ssh project: Install agent, with a line on what it is for. While it
 *   runs the button waits and the progress lines show; a failure shows its
 *   message and Retry. Once it is done the project is a VM project, and the
 *   page shows the Setup section instead.
 * - On a VM project: Setup, a check per tool (installed with its version, and
 *   signed in), Check again, and Open setup terminal, which opens the shell
 *   setup runs in like any session. Update agent shows while the agent there
 *   isn't the app's version, and reuses the install.
 *
 * What each part says is `agent-host-view`; what it does is `agent-actions`.
 */
import {useEffect} from 'react';
import type {JSX} from 'react';
import {useStore} from '../use-store';
import {hostViewIn} from '../../state/agent-host-slice';
import {INSTALL_HELP, installView, offersUpdate, setupDone, toolLines} from './agent-host-view';
import {installAgent, loadAgentStatus, openAgentSetupTerminal, refreshAgentTools} from './agent-actions';
import type {InstallView} from './agent-host-view';

/** Install agent on an ssh project. */
export function InstallAgentCard({projectPath}: {projectPath: string}): JSX.Element {
    const install = useStore((state) => hostViewIn(state.agentHost, projectPath).install);
    const view = installView(install);
    return (
        <section className="pp-section pp-agent" aria-labelledby="pp-agent-heading">
            <div className="pp-section-head">
                <h2 id="pp-agent-heading">Switchboard agent</h2>
            </div>
            <div className="pp-card pp-message">
                <div className="pp-message-text">{INSTALL_HELP}</div>
                <InstallProgress view={view} />
                <div className="pp-message-actions">
                    <button
                        type="button"
                        className="sw-btn is-primary"
                        disabled={view.disabled}
                        onClick={() => void installAgent(projectPath)}>
                        {view.label}
                    </button>
                </div>
            </div>
        </section>
    );
}

/** Setup on a VM project: the tool checks, the setup terminal and Update agent. */
export function SetupSection({projectPath}: {projectPath: string}): JSX.Element {
    const host = useStore((state) => hostViewIn(state.agentHost, projectPath));

    // Asked as the page opens on the project, and again from Check again.
    useEffect(() => {
        void loadAgentStatus(projectPath);
        void refreshAgentTools(projectPath);
    }, [projectPath]);

    const tools = host.tools;
    const update = installView(host.install, 'Update agent');
    const phase = host.install.phase;
    const showUpdate = offersUpdate(host) || phase === 'running' || phase === 'failed';
    return (
        <section className="pp-section pp-setup" aria-labelledby="pp-setup-heading">
            <div className="pp-section-head">
                <h2 id="pp-setup-heading">Setup</h2>
                {tools?.phase === 'ok' && setupDone(tools.tools) && <span className="pp-count">Ready</span>}
            </div>
            <div className="pp-card" aria-busy={!tools || tools.phase === 'loading'}>
                {(!tools || tools.phase === 'loading') && <div className="pp-quiet">Checking the VM…</div>}
                {tools?.phase === 'unreachable' && (
                    <div className="pp-quiet" role="status">
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
                <div className="pp-message-actions pp-setup-actions">
                    <button type="button" className="sw-btn" onClick={() => void openAgentSetupTerminal(projectPath)}>
                        Open setup terminal
                    </button>
                    <button type="button" className="sw-btn" onClick={() => void refreshAgentTools(projectPath)}>
                        Check again
                    </button>
                    {showUpdate && (
                        <button
                            type="button"
                            className="sw-btn"
                            disabled={update.disabled}
                            onClick={() => void installAgent(projectPath)}>
                            {update.label}
                        </button>
                    )}
                </div>
                {host.setupError && (
                    <div className="pp-agent-error" role="alert">
                        {host.setupError}
                    </div>
                )}
                {phase !== 'idle' && <InstallProgress view={update} />}
            </div>
        </section>
    );
}

/** The install's progress lines, and why it failed. */
function InstallProgress({view}: {view: InstallView}): JSX.Element | null {
    if (view.lines.length === 0 && !view.error) return null;
    return (
        <>
            {view.lines.length > 0 && (
                <pre className="pp-agent-log" aria-live="polite">
                    {view.lines.join('\n')}
                </pre>
            )}
            {view.error && (
                <div className="pp-agent-error" role="alert">
                    {view.error}
                </div>
            )}
        </>
    );
}

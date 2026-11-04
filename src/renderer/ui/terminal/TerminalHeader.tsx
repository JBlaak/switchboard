/**
 * The bar above the terminal: which session, whether it is running, and what
 * the process last called itself.
 *
 * Two halves, each portalled into its own container in `#terminal-header`
 * (see `Root`): the header also holds the question panel's slot, which that
 * feature fills itself, between the info and the status. The header element
 * stays in `index.html` so the settings panel can keep hiding and showing it;
 * whether it is up follows the session on screen.
 *
 * The header is a window drag region; the stylesheet opts its spans and
 * buttons out (`_chrome.scss`), which is why the markup keeps its ids.
 */
import {useLayoutEffect} from 'react';
import type {JSX} from 'react';
import {remoteStatusLabel} from '../../../domain/remote/remote-status';
import {shallowEqual} from '../../state/store';
import {headerShellIn, headerTitleIn} from '../../state/terminal-slice';
import {useStore} from '../use-store';
import {stopSessionOnScreen} from './actions';
import {sessionMap} from '../../state/session-store';
import {projectLabel} from '../../features/sessions/project-label';
import {ProjectLink} from '../project-page/ProjectLink';
import {TaskChip} from '../session-task/TaskChip';
import {canHandOffSession} from '../../state/session-list-layout';
import {HandOffSessionButton} from '../session-handoff/HandOffSessionButton';
import {HandoffMarker} from '../session-handoff/HandoffMarker';
import {PageHeaderButton} from '../reading-page/PageHeaderButton';

/**
 * The session's name, its project (a way into the project page, #173), its
 * BlaakTasks task (#250), the process title (or a CLI notice), its id and its shell.
 */
export function TerminalHeaderInfo(): JSX.Element {
    const {onScreen, name, title, shell} = useStore(
        (state) => ({
            onScreen: state.terminal.onScreen,
            name: state.terminal.headerName,
            title: headerTitleIn(state.terminal),
            shell: headerShellIn(state.terminal),
        }),
        shallowEqual,
    );

    useLayoutEffect(() => {
        const header = document.getElementById('terminal-header');
        if (header) header.style.display = onScreen ? '' : 'none';
    }, [onScreen]);

    // The row is shared and its project never changes, so it is read as rendered.
    const projectPath = onScreen ? (sessionMap.get(onScreen)?.projectPath ?? null) : null;

    return (
        <>
            <span id="terminal-header-name">{name}</span>
            {projectPath && (
                <ProjectLink
                    id="terminal-header-project"
                    className={projectPath.startsWith('ssh://') ? 'is-remote' : undefined}
                    path={projectPath}>
                    {projectLabel(projectPath)}
                </ProjectLink>
            )}
            <TaskChip sessionId={onScreen} />
            <span id="terminal-header-pty-title" style={title ? undefined : {display: 'none'}}>
                {title}
            </span>
            <span id="terminal-header-id">{onScreen ?? ''}</span>
            <span id="terminal-header-shell" style={shell ? undefined : {display: 'none'}}>
                {shell ?? ''}
            </span>
        </>
    );
}

/**
 * Running or stopped, Hand off to… for a local Claude session once there is a
 * VM host (#276 stage 3) with its marker while one is in flight, and the Stop
 * button while it is running.
 *
 * A remote session mid-connect is neither running nor stopped, and saying
 * either is misleading — so a connection label takes precedence when there is
 * one. Its countdown re-renders off the shared remote tick.
 */
export function TerminalHeaderControls(): JSX.Element {
    const {onScreen, hosts, running, remote} = useStore((state) => {
        const id = state.terminal.onScreen;
        return {
            onScreen: id,
            hosts: state.handoff.hosts,
            running: !!id && state.view.activePtyIds.has(id),
            remote: id ? state.remote.statuses[id] : undefined,
            // Selected only so each tick re-renders the countdown.
            tickAt: state.remote.tickAt,
        };
    }, shallowEqual);

    const connecting = remoteStatusLabel(remote);
    const status = connecting ? 'connecting' : running ? 'running' : 'stopped';
    const label = connecting ?? (running ? 'Running' : 'Stopped');
    // The row is shared; a hand-off that finished makes it a VM session, and the reopened terminal re-renders this.
    const row = onScreen ? sessionMap.get(onScreen) : undefined;
    const handOff = !!onScreen && !!row && !!hosts && canHandOffSession(row, hosts.length);

    return (
        <>
            {onScreen && <HandoffMarker sessionId={onScreen} />}
            {onScreen && <PageHeaderButton sessionId={onScreen} />}
            {handOff && hosts && (
                <HandOffSessionButton
                    sessionId={onScreen}
                    hosts={hosts}
                    id="terminal-handoff-btn"
                    className="sw-btn terminal-handoff-btn"
                />
            )}
            <span id="terminal-header-status" className={status}>
                {label}
            </span>
            <button
                id="terminal-stop-btn"
                title="Stop process"
                onClick={stopSessionOnScreen}
                style={running ? undefined : {display: 'none'}}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                    <rect x="2" y="2" width="8" height="8" rx="1" />
                </svg>
            </button>
        </>
    );
}

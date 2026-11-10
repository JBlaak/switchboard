/**
 * The bar above the terminal, slimmed to what is read at a glance (#343, epic
 * #338): the session's name, its project and its branch on the left; the
 * questions, the hand-off marker while one runs, and whether it is running on
 * the right. Everything used now and then is in the session tray that drops
 * over the terminal when the bar is hovered (`session-tray/SessionTray`).
 *
 * Two halves, each portalled into its own container in `#terminal-header`
 * (see `Root`): the header also holds the question panel's slot, which that
 * feature fills itself, between the info and the status. The header element
 * stays in `index.html` so the settings panel can keep hiding and showing it;
 * whether it is up follows the session on screen.
 *
 * The header moves the window from its blank space, by hand rather than as a
 * CSS drag region (`_chrome.scss`): a drag region never hands the page a
 * pointer event, so hovering it would close the session tray.
 */
import {useEffect, useLayoutEffect} from 'react';
import type {JSX, ReactNode} from 'react';
import {remoteStatusLabel} from '../../../domain/remote/remote-status';
import {shallowEqual} from '../../state/store';
import {headerTitleIn} from '../../state/terminal-slice';
import {sessionStatsIn, trayIsOpen} from '../../state/session-tray-slice';
import {dispatch} from '../../state/app-store';
import {useStore} from '../use-store';
import {sessionMap} from '../../state/session-store';
import {projectLabel} from '../../features/sessions/project-label';
import {ProjectLink} from '../project-page/ProjectLink';
import {HandoffMarker} from '../session-handoff/HandoffMarker';
import {loadSessionStats} from '../session-tray/actions';
import {SESSION_TRAY_ID, focusTray} from '../session-tray/focus';
import {installDragSpace} from '../session-list/drag-space';

/** What in the bar keeps its press: controls, and text that can be selected. */
const KEEPS_PRESS = 'button, input, a, [role="button"], #terminal-header-info > span, #terminal-header-questions';

/** Whether a press on `target` in the bar moves the window: only on its blank space and plain labels. */
function headerPressMovesWindow(target: Element): boolean {
    return target.closest(KEEPS_PRESS) === null;
}

/** The session's name (its process title as the tooltip), its project (a way into the project page, #173) and its branch. */
export function TerminalHeaderInfo(): JSX.Element {
    const {onScreen, name, title, branch, open} = useStore((state) => {
        const id = state.terminal.onScreen;
        return {
            onScreen: id,
            name: state.terminal.headerName,
            title: headerTitleIn(state.terminal),
            branch: sessionStatsIn(state.sessionTray, id)?.branch ?? null,
            open: trayIsOpen(state.sessionTray.phase),
        };
    }, shallowEqual);

    useLayoutEffect(() => {
        const header = document.getElementById('terminal-header');
        if (header) header.style.display = onScreen ? '' : 'none';
    }, [onScreen]);

    useEffect(() => {
        const header = document.getElementById('terminal-header');
        return header ? installDragSpace(header, headerPressMovesWindow) : undefined;
    }, []);

    // The branch is read fresh for each session put on screen (and again as the tray opens).
    useEffect(() => {
        if (onScreen) void loadSessionStats(onScreen);
    }, [onScreen]);

    // The row is shared and its project never changes, so it is read as rendered.
    const projectPath = onScreen ? (sessionMap.get(onScreen)?.projectPath ?? null) : null;

    return (
        <TerminalHeaderInfoContent
            name={name}
            title={title}
            project={
                projectPath && (
                    <ProjectLink
                        id="terminal-header-project"
                        className={projectPath.startsWith('ssh://') ? 'is-remote' : undefined}
                        path={projectPath}>
                        {projectLabel(projectPath)}
                    </ProjectLink>
                )
            }
            branch={branch}
            trayOpen={open}
        />
    );
}

export interface TerminalHeaderInfoContentProps {
    name: string;
    /** What the process last called itself (or the CLI's notice): the name's tooltip. */
    title: string;
    /** The project, as a way into its page (#173); a slot so the markup draws without the store. */
    project: ReactNode;
    branch: string | null;
    trayOpen: boolean;
}

/** The left half's markup, from what it shows. */
export function TerminalHeaderInfoContent({
    name,
    title,
    project,
    branch,
    trayOpen,
}: TerminalHeaderInfoContentProps): JSX.Element {
    return (
        <>
            <span id="terminal-header-name" title={title || undefined}>
                {name}
            </span>
            {project}
            {branch && (
                <span id="terminal-header-branch" title={'On ' + branch}>
                    {branch}
                </span>
            )}
            <button
                type="button"
                id="terminal-header-tray-hint"
                aria-label="Session tools"
                aria-controls={SESSION_TRAY_ID}
                aria-expanded={trayOpen}
                onClick={() => {
                    dispatch({type: 'trayOpened'});
                    focusTray();
                }}>
                hover for tools
            </button>
        </>
    );
}

/**
 * The hand-off marker while one is in flight (#276 stage 3), and running or
 * stopped.
 *
 * A remote session mid-connect is neither running nor stopped, and saying
 * either is misleading — so a connection label takes precedence when there is
 * one. Its countdown re-renders off the shared remote tick.
 */
export function TerminalHeaderControls(): JSX.Element {
    const {onScreen, running, remote} = useStore((state) => {
        const id = state.terminal.onScreen;
        return {
            onScreen: id,
            running: !!id && state.view.activePtyIds.has(id),
            remote: id ? state.remote.statuses[id] : undefined,
            // Selected only so each tick re-renders the countdown.
            tickAt: state.remote.tickAt,
        };
    }, shallowEqual);

    const connecting = remoteStatusLabel(remote);
    const status = connecting ? 'connecting' : running ? 'running' : 'stopped';
    const label = connecting ?? (running ? 'Running' : 'Stopped');

    return (
        <>
            {onScreen && <HandoffMarker sessionId={onScreen} />}
            <span id="terminal-header-status" className={status}>
                {label}
            </span>
        </>
    );
}

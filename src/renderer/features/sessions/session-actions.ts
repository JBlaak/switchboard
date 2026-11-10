/**
 * The things a user does to a session: open it, start a new one, stop it,
 * archive it.
 *
 * Each of these has an order that matters — a row is only hidden once nothing
 * is running under it, a new row appears before the CLI has written anything —
 * so they live together rather than being inlined at each of the several places
 * that trigger them.
 */
import {encodeProjectPath} from '../../../domain/project/project-path';
import {sessionExitedBanner} from '../../../domain/terminal/ansi';
import {relayoutSessionList} from '../../ui/session-list/relayout';
import {resolveDefaultSessionOptions} from '../dialogs/launch-options';
import {setActiveSession} from './active-session';
import {pollActiveSessions} from './session-poller';
import {
    injectIntoCaches,
    openSessions,
    pendingSessions,
    removeFromCaches,
    sessionMap,
    view,
} from '../../state/session-store';
import {dispatch, getState} from '../../state/app-store';
import {isVmProjectIn} from '../../state/agent-host-slice';
import {sidebarContent} from '../../lib/dom';
import {bump} from '../../lib/motion/reflow';
import {createTerminalEntry, destroySession, showSession} from '../terminal/terminal-manager';
import type {Project} from '../../../domain/project/project';
import type {SessionRow} from '../../../domain/session/session';
import type {SessionOptions} from '../../../domain/launch/session-options';
import {archiveAnswerEvents} from '../../ui/session-task/offer';

/** A row for a session that has not been written to disk yet. */
export function newSessionRow(projectPath: string, fields: Partial<SessionRow> = {}): SessionRow {
    const now = new Date().toISOString();
    return {
        sessionId: crypto.randomUUID(),
        summary: 'New session',
        firstPrompt: '',
        projectPath,
        name: null,
        starred: 0,
        archived: 0,
        messageCount: 0,
        modified: now,
        created: now,
        ...fields,
    };
}

/**
 * Register a session the renderer invented, so it has a row to look at.
 *
 * Pending until the project list comes back carrying a real one — see
 * `isPendingAbandoned` for what happens when it never does.
 */
function trackPending(session: SessionRow, remote = false): void {
    const folder = encodeProjectPath(session.projectPath);
    pendingSessions.set(session.sessionId, {session, projectPath: session.projectPath, folder});
    injectIntoCaches(session, folder, remote);
    relayoutSessionList();
}

/**
 * A session main started without being asked here (a phone's Ask Patch,
 * #194): the same pending row one started here gets, so it is in the sidebar
 * before its transcript is. Nothing is spawned; opening the row reattaches.
 */
export function trackStartedElsewhere(sessionId: string, projectPath: string): void {
    if (sessionMap.has(sessionId) || pendingSessions.has(sessionId)) return;
    trackPending(newSessionRow(projectPath, {sessionId}));
    void pollActiveSessions();
}

/**
 * A session handed off to a VM (#276 stage 3) now runs there under the same
 * id; the local one has exited.
 *
 * The row is the same row, now a Claude session on the copy, until the next
 * project reload rebuilds it from the agent. Its terminal still holds the
 * local run with an exit banner, and is marked closed, so a click would
 * relaunch it as the local session it no longer is. So it goes: on screen it
 * is reopened at once, which attaches to the session on the VM; off screen
 * the next click does that.
 */
export function continueOnVm(sessionId: string, copyPath: string): void {
    const row = sessionMap.get(sessionId) ?? pendingSessions.get(sessionId)?.session;
    if (!row) return;
    row.projectPath = copyPath;
    row.type = 'remote';
    row.remoteKind = 'claude';
    if (openSessions.has(sessionId)) {
        const onScreen = getState().terminal.onScreen === sessionId;
        destroySession(sessionId);
        if (onScreen) void openSession(row);
    }
    relayoutSessionList();
}

/**
 * A VM session brought back to this Mac (#276) continues in its own row: the
 * row becomes a local Claude session in the checkout it resumed in, and an
 * open terminal is opened again, which attaches to the session main already
 * started here. The project list read after puts the row under its project.
 */
export function continueHere(sessionId: string, projectPath: string): void {
    const row = sessionMap.get(sessionId) ?? pendingSessions.get(sessionId)?.session;
    if (!row) return;
    row.projectPath = projectPath;
    delete row.type;
    delete row.remoteKind;
    if (openSessions.has(sessionId)) {
        const onScreen = getState().terminal.onScreen === sessionId;
        destroySession(sessionId);
        if (onScreen) void openSession(row);
    }
    relayoutSessionList();
}

/**
 * The setup terminal main started on a VM's host (#276): a shell row for it,
 * opened in the terminal area the way any session is, by its id. Opening it
 * attaches to the shell already running on the agent.
 */
export async function openSetupTerminal(sessionId: string, projectPath: string): Promise<void> {
    const existing = sessionMap.get(sessionId) ?? pendingSessions.get(sessionId)?.session;
    if (existing) {
        await openSession(existing);
        return;
    }
    const session = newSessionRow(projectPath, {
        sessionId,
        summary: 'Setup terminal',
        type: 'remote',
        remoteKind: 'shell',
    });
    trackPending(session, true);
    await openSession(session);
}

/**
 * A Claude session with the project's default options, local or remote.
 *
 * `initialPrompt` is what a local session starts on (#135); the options it is
 * launched with are otherwise exactly the defaults. A session on a VM agent
 * (#276) gets both, as a local one does; one on an agentless remote takes
 * neither, because tmux starts a bare `claude`.
 */
export async function launchClaudeSession(
    project: Project,
    {initialPrompt}: {initialPrompt?: string} = {},
): Promise<void> {
    if (project.remote && project.agent) {
        const options = await resolveDefaultSessionOptions(project.projectPath);
        await launchRemoteSession(project, initialPrompt ? {...options, initialPrompt} : options);
        return;
    }
    if (project.remote) {
        await launchRemoteSession(project);
        return;
    }
    const options = await resolveDefaultSessionOptions(project.projectPath);
    await launchNewSession(project, initialPrompt ? {...options, initialPrompt} : options);
}

/**
 * Start a Claude session and put it on screen.
 *
 * The terminal is created before the request goes out, so an error has
 * somewhere to be printed — which is the only place a failed pre-launch command
 * is visible.
 */
async function launchNewSession(project: Project, options?: SessionOptions): Promise<void> {
    const session = newSessionRow(project.projectPath);
    trackPending(session);
    await spawn(session, {isNew: true, options});
}

/**
 * Start a plain terminal, in place of one whose shell has exited.
 *
 * Deliberately not a Claude session: no MCP bridge, no transcript, and it is
 * torn down when its shell exits rather than kept around to read.
 */
async function launchTerminalSession(project: Project): Promise<void> {
    const session = newSessionRow(project.projectPath, {summary: 'Terminal', type: 'terminal'});
    trackPending(session);
    await spawn(session, {isNew: true, options: {type: 'terminal'}});
}

/**
 * Start a Claude session on a remote project.
 *
 * The main process records it in settings and connects ssh to a fresh tmux
 * session; unlike a plain terminal the sidebar row persists, so after a
 * disconnect — or an app restart — clicking it re-attaches to the session still
 * running on the far end.
 */
async function launchRemoteSession(project: Project, options: SessionOptions = {}): Promise<void> {
    const session = newSessionRow(project.projectPath, {
        summary: project.agent ? 'Claude on VM' : 'Remote Claude',
        type: 'remote',
        remoteKind: 'claude',
    });
    trackPending(session, true);
    await spawn(session, {isNew: true, options: {...options, type: 'remote', remoteKind: 'claude'}});
}

/** Open an existing session, or bring it forward if it is already open. */
export async function openSession(session: SessionRow, options?: SessionOptions): Promise<void> {
    const existing = openSessions.get(session.sessionId);
    if (existing) {
        if (!existing.closed) {
            showSession(session.sessionId);
            return;
        }
        // A closed terminal is a corpse with an exit banner in it; relaunching
        // means starting over, so it goes first.
        destroySession(session.sessionId);
        if (session.type === 'terminal') {
            await launchTerminalSession(projectStub(session.projectPath));
            return;
        }
    }

    // Sessions on an agentless remote ignore local launch options — the main
    // process reconnects from its stored session record. A VM's Claude session
    // (#276) resumes with them, as a local one does: Resume with config's, or
    // else the project's defaults.
    const remote: SessionOptions = {type: 'remote', remoteKind: session.remoteKind};
    const vm = session.type === 'remote' && isVmProjectIn(getState().agentHost, session.projectPath);
    const resumeOptions: SessionOptions =
        session.type === 'remote'
            ? vm && session.remoteKind !== 'shell'
                ? {...(options ?? (await resolveDefaultSessionOptions(session.projectPath))), ...remote}
                : remote
            : (options ?? (await resolveDefaultSessionOptions(session.projectPath)));

    await spawn(session, {isNew: false, options: resumeOptions});
}

/**
 * Start a Claude session in a directory with exactly these options, and put
 * it on screen unless `show` is false (it then runs in its row, like any
 * session in the background). Answers its id, or why it did not start (also
 * printed in its terminal, as for any launch).
 */
export async function startClaudeSessionIn(
    projectPath: string,
    options: SessionOptions,
    {show = true}: {show?: boolean} = {},
): Promise<{ok: true; sessionId: string} | {ok: false; reason: string}> {
    const session = newSessionRow(projectPath);
    trackPending(session);
    const error = await spawn(session, {isNew: true, options, show});
    return error === null ? {ok: true, sessionId: session.sessionId} : {ok: false, reason: error};
}

/**
 * Start a Claude session in a VM project (#276) with exactly these options,
 * as `startClaudeSessionIn` does here: a start handed off before it began
 * ("Do you want to hand this off to…?") runs in the copy it was sent to.
 */
export async function startClaudeSessionOnVm(
    copyPath: string,
    options: SessionOptions,
    {show = true}: {show?: boolean} = {},
): Promise<{ok: true; sessionId: string} | {ok: false; reason: string}> {
    const session = newSessionRow(copyPath, {summary: 'Claude on VM', type: 'remote', remoteKind: 'claude'});
    trackPending(session, true);
    const error = await spawn(session, {
        isNew: true,
        options: {...options, type: 'remote', remoteKind: 'claude'},
        show,
    });
    return error === null ? {ok: true, sessionId: session.sessionId} : {ok: false, reason: error};
}

/**
 * Create the terminal, ask main to start the process, and show the result
 * (unless `show` is false). Answers why it could not start, or null when it did.
 */
async function spawn(
    session: SessionRow,
    {isNew, options, show = true}: {isNew: boolean; options?: SessionOptions; show?: boolean},
): Promise<string | null> {
    const entry = createTerminalEntry(session);

    const result = await window.api.openTerminal(session.sessionId, session.projectPath, isNew, options ?? undefined);

    if (!result.ok) {
        entry.terminal.write(`\r\nError: ${result.error}\r\n`);
        entry.closed = true;
        return String(result.error ?? 'The session could not start');
    }

    if (show) showSession(session.sessionId);
    void pollActiveSessions();
    return null;
}

/** Stop a session, after asking — it is destructive and cannot be undone. */
export async function confirmAndStopSession(sessionId: string): Promise<void> {
    const session = sessionMap.get(sessionId);
    // A session on a VM (#276) stops, as a local one does; an ssh one only disconnects.
    const disconnects = session?.type === 'remote' && !isVmProjectIn(getState().agentHost, session.projectPath);
    const prompt = disconnects ? 'Disconnect? The session keeps running on the remote machine.' : 'Stop this session?';
    if (!confirm(prompt)) return;

    await window.api.stopSession(sessionId);
    dispatch({type: 'ptyStopped', sessionId});
    if (view.activeSessionId === sessionId) forgetActiveSession();
    relayoutSessionList();
    settleStoppedRow(sessionId);
}

/** A small squash on the stopped row, and its status dot dipping, so the stop lands. */
function settleStoppedRow(sessionId: string): void {
    const row = sidebarContent.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
    if (!row) return;
    bump(row, -1.2);
    bump(row.querySelector('.session-status-dot'), -6);
}

/**
 * Archive a session, or bring it back.
 *
 * Archiving is also how a row gets forgotten, so it has to stop the process
 * first and only hide the row once nothing is running under it. Answers false
 * when the stop failed, so the caller leaves the row where it is rather than
 * orphaning a live PTY behind a hidden row.
 *
 * The three call sites — a row, a slug group, a whole project — all come
 * through here, so none of them can drift back into hiding a live session.
 */
export async function archiveSessionRow(session: SessionRow, archived: number): Promise<boolean> {
    const {sessionId} = session;

    if (archived) {
        // Stop unconditionally: `activePtyIds` can lag the real state by up to the
        // idle poll interval, and stopping a dead session is a no-op.
        const result = await window.api.stopSession(sessionId);
        if (result && result.ok === false) {
            alert(`Could not stop this session: ${result.error || 'unknown error'}`);
            return false;
        }
        dispatch({type: 'ptyStopped', sessionId});
    }

    const answer = await window.api.archiveSession(sessionId, Boolean(archived));
    session.archived = archived;
    if (archived) closeArchivedSession(sessionId);
    // Its task's PRs are all merged: Mark task done? (#248, #250)
    for (const event of archiveAnswerEvents(sessionId, answer)) dispatch(event);
    return true;
}

/**
 * What goes with an archived row, here or from a phone: main has already
 * stopped the session and archived the row.
 */
export function closeArchivedSession(sessionId: string): void {
    const row = sessionMap.get(sessionId);
    if (row) row.archived = 1;
    // A pending row has no transcript to resume from, so archiving it means
    // forgetting it — and leaving the pending entry behind would re-inject the
    // row on the next refresh with its own `archived: 0`.
    if (pendingSessions.has(sessionId)) dropPendingSession(sessionId);
    // Its terminal goes too, rather than staying on screen with an exit banner
    // in it for a session that is no longer in the list.
    else closeSessionView(sessionId);
}

/**
 * Snooze a session until `until` (an ISO time), or wake it with null.
 *
 * Unlike archiving, nothing is stopped: a snoozed session only leaves the
 * list, and anything running under it keeps running.
 */
export async function snoozeSessionRow(session: SessionRow, until: string | null): Promise<void> {
    await window.api.snoozeSession(session.sessionId, until);
    session.snoozedUntil = until;
}

/**
 * Forget a row the renderer invented and nothing ever came of.
 *
 * Takes its terminal with it, so a header still naming that pane would be
 * pointing at nothing.
 */
export function dropPendingSession(sessionId: string): void {
    pendingSessions.delete(sessionId);
    sessionMap.delete(sessionId);
    removeFromCaches(sessionId);
    closeSessionView(sessionId);
}

/** Tear down a session's terminal, and forget it as the session to return to. */
function closeSessionView(sessionId: string): void {
    if (openSessions.has(sessionId)) destroySession(sessionId);
    if (view.activeSessionId === sessionId) forgetActiveSession();
}

/**
 * The active session went away. When it was on screen, the empty screen takes
 * its place; a project or the settings covering it stay, with nothing to go
 * back to (see `main-area-slice`).
 */
function forgetActiveSession(): void {
    setActiveSession(null);
}

/**
 * Nothing is on screen: the empty screen takes the main area, whatever had
 * it, and there is no session to return to.
 *
 * The session's terminal stays alive; opening the row again shows it as it was.
 * No session active is what takes the terminal and the header off screen (see
 * `terminal-slice`).
 */
export function clearScreen(): void {
    setActiveSession(null);
    dispatch({type: 'screenCleared'});
}

/** Write the exit banner into a terminal whose process has ended. */
export function writeExitBanner(sessionId: string, exitCode: number): void {
    const entry = openSessions.get(sessionId);
    if (!entry) return;
    entry.closed = true;
    try {
        entry.terminal.write(sessionExitedBanner(exitCode));
    } catch {
        // The terminal was disposed between the exit event and this write.
    }
}

/**
 * A stand-in project for the call sites that only have a path.
 *
 * The launchers read nothing but `projectPath`; building the rest would be
 * inventing data.
 */
export function projectStub(projectPath: string): Project {
    return {projectPath, folder: encodeProjectPath(projectPath), sessions: []};
}

/**
 * Session state: which are running, stopping one, and the per-session metadata.
 */
import {INVOKE, SEND} from '../../ipc/channels';
import {searchTitleFor} from '../../domain/session/title';
import {reconnectSession} from '../reconnect-session';
import {stopSession} from '../stop-session';
import type {Container} from '../composition-root';
import type {PinRef, PinSection, PinTarget} from '../../domain/pin/pin-order';
import type {IpcRegistrar} from './support/registrar';

export function registerSessionHandlers(ipc: IpcRegistrar, app: Container): void {
    ipc.handle(INVOKE.getActiveSessions, () => app.lifecycle.runningSessionIds());

    /** The window is ready: the sessions a restart brought back can be marked now. */
    ipc.on(SEND.rendererReady, () => app.sessionRestore.rendererReady());

    /** The plain terminals, so a reloaded renderer can restore them. */
    ipc.handle(INVOKE.getActiveTerminals, () => {
        const terminals: {sessionId: string; projectPath: string}[] = [];
        for (const [sessionId, session] of app.registry.snapshot()) {
            if (session.exited || !session.isPlainTerminal) continue;
            terminals.push({sessionId, projectPath: session.projectPath});
        }
        return terminals;
    });

    ipc.handle(INVOKE.stopSession, (sessionId: string) => stopSession(app, sessionId));

    /** "Retry now" on a session's connection card; see `reconnectSession`. */
    ipc.handle(INVOKE.reconnectRemote, (sessionId: string) => reconnectSession(app, sessionId));

    // Each pin lands at the end of its section, and the section's order comes back with it (#379).
    ipc.handle(INVOKE.toggleStar, (sessionId: string) => {
        const {result, order} = app.pinOrder.toggle(
            'sessions',
            {kind: 'session', sessionId},
            () => app.repository.toggleStar(sessionId),
            (starred) => starred === 1,
        );
        return {starred: result, order};
    });

    ipc.handle(INVOKE.togglePlanPin, (projectPath: string, slug: string) => {
        const {result, order} = app.pinOrder.toggle(
            'plans',
            {kind: 'plan', projectPath, slug},
            () => app.repository.togglePlanPin(projectPath, slug),
            (pinned) => pinned,
        );
        return {pinned: result, order};
    });
    ipc.handle(INVOKE.toggleIssuePlanPin, (projectPath: string, repository: string, number: number, title: string) => {
        const {result, order} = app.pinOrder.toggle(
            'plans',
            {kind: 'issuePlan', projectPath, repository, number},
            () => app.repository.toggleIssuePlanPin(projectPath, repository, number, title),
            (pinned) => pinned,
        );
        return {pinned: result, order};
    });
    ipc.handle(INVOKE.toggleProjectPin, (projectPath: string) => {
        const {result, order} = app.pinOrder.toggle(
            'projects',
            {kind: 'project', projectPath},
            () => app.repository.toggleProjectPin(projectPath),
            (pinned) => pinned,
        );
        return {pinned: result, order};
    });

    /** Dragging a pinned row, or ⌥↑ / ⌥↓ on one (#379). */
    ipc.handle(INVOKE.movePins, (section: PinSection, moving: PinRef[], target: PinTarget) => ({
        order: app.pinOrder.move(section, moving, target),
    }));

    /**
     * Rename a session.
     *
     * The search index carries the name as part of its title, so a rename has to
     * update it or the session stops being findable under its new name until the
     * next re-index.
     */
    ipc.handle(INVOKE.renameSession, (sessionId: string, name: string | null) => {
        app.repository.setName(sessionId, name || null);
        const summary = app.repository.getCachedSession(sessionId)?.summary || '';
        app.searchIndex.updateTitle(sessionId, 'session', searchTitleFor({storedName: name}, summary));
        return {name: name || null};
    });

    // The window has closed it already; a phone with it open closes it too, and
    // its worktrees go after, when Settings says so. Its task (#248) gets a line,
    // and when every PR the session opened is merged the answer offers Mark done:
    // archived here, it was archived by you.
    ipc.handle(INVOKE.archiveSession, async (sessionId: string, archived: boolean) => {
        app.repository.setArchived(sessionId, archived);
        if (!archived) return {archived: 0};
        app.phoneSessions.sessionArchived(sessionId);
        void app.worktreeCleanup.afterArchive(sessionId);
        const markDone = await app.tasks.archived(sessionId, {byUser: true});
        return markDone ? {archived: 1, markDone} : {archived: 1};
    });

    ipc.handle(INVOKE.snoozeSession, (sessionId: string, until: string | null) => {
        app.repository.setSnoozedUntil(sessionId, until);
    });

    /** The session tray's stats (#341), read fresh so a checkout shows on the next ask. */
    ipc.handle(INVOKE.getSessionStats, (sessionId: string) => app.sessionStats.stats(sessionId));
}

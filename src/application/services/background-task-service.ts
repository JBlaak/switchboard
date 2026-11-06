/**
 * The background tasks each running session's turn ended with still running,
 * for the sidebar and the phones: they decide whether an ended turn is still
 * working, the user's turn, or merging (`domain/session/status-tone`).
 *
 * The CLI says nothing about them on the terminal, but the transcript does
 * (`domain/session/background-tasks`). So whenever a turn ends, the end of the
 * session's transcript is read and what is still running is pushed
 * (`sessionBackgroundTasks`), when it changed. A turn starting clears it: the
 * session is working whatever runs beside it, and the next turn's end reads
 * it again, which is also how a finished task drops out, since its report
 * wakes Claude for a turn of its own.
 *
 * Only a local transcript is read. A session on an ssh remote or a VM has
 * none here, so its turns end as they did before: the user's turn.
 */
import {runningBackgroundTasks, type BackgroundTask} from '../../domain/session/background-tasks';
import {encodeProjectPath} from '../../domain/project/project-path';
import type {CliStateChange} from '../../domain/terminal/osc';
import type {ActiveSession} from '../model/active-session';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {TranscriptStore} from '../ports/transcript-store';
import type {CliStateObserver} from './session-lifecycle';

/**
 * How much of the transcript's end is read: the turn's background launches are
 * in it unless the turn wrote more than this after them, and then they are
 * missed and the turn reads as the user's, as before.
 */
export const BACKGROUND_TAIL_BYTES = 1024 * 1024;

export interface BackgroundTaskServiceDeps {
    transcripts: Pick<TranscriptStore, 'readTail'>;
    renderer: Pick<RendererGateway, 'sessionBackgroundTasks'>;
    log: Logger;
}

export class BackgroundTaskService implements CliStateObserver {
    /** sessionId → what was pushed last, as JSON; absent is none. */
    private readonly published = new Map<string, string>();

    constructor(private readonly deps: BackgroundTaskServiceDeps) {}

    public cliStateChanged(sessionId: string, session: ActiveSession, change: CliStateChange): void {
        if (change.kind !== 'busy' || session.isPlainTerminal) return;
        this.publish(sessionId, change.busy ? [] : this.read(sessionId, session));
    }

    public sessionEnded(sessionId: string): void {
        this.published.delete(sessionId);
    }

    private read(sessionId: string, session: ActiveSession): BackgroundTask[] {
        const folder = session.projectFolder ?? encodeProjectPath(session.projectPath);
        const tail = this.deps.transcripts.readTail(folder, sessionId, BACKGROUND_TAIL_BYTES);
        if (!tail) return [];
        return runningBackgroundTasks(tail.split('\n'), session.openedAt);
    }

    private publish(sessionId: string, tasks: BackgroundTask[]): void {
        const key = JSON.stringify(tasks);
        if ((this.published.get(sessionId) ?? '[]') === key) return;
        if (tasks.length > 0) this.published.set(sessionId, key);
        else this.published.delete(sessionId);
        this.deps.log.debug(
            `[background] session=${sessionId} tasks=${tasks.map((t) => t.id + (t.watch ? ':watch' : ':work')).join(',')}`,
        );
        this.deps.renderer.sessionBackgroundTasks(sessionId, tasks);
    }
}

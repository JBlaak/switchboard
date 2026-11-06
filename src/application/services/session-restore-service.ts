/**
 * Bringing the local sessions back after Switchboard restarts or the Mac reboots.
 *
 * A local session runs as a child of the app, so quitting, a crash or a
 * shutdown takes it down, and nothing else remembers it was running. This
 * keeps that record (`live-sessions` in the settings store) as sessions start,
 * re-key and end, and resumes what is in it when the app starts again.
 *
 * A session leaves the record when it ends while the app runs: the user
 * stopped or archived it, it exited, or it died on its own, all of which its
 * row already shows. One the app ended on its way out (`endedByApp`, set by
 * `terminateAll`) stays, and so does every session once the app is quitting or
 * the Mac is shutting down (`freeze`), because a shutdown may take the
 * processes down before the app hears it is quitting. A crash writes nothing,
 * so everything in the record stays.
 *
 * A restored session is resumed the way Resume does it, in the folder it was
 * launched in, with the project's launch options. One whose turn was cut off
 * mid tool call or on a prompt is marked "Interrupted by restart: <tool>" and
 * left waiting: nothing is ever typed into it. Remote sessions never enter the
 * record; they outlive the app on their hosts.
 */
import {encodeProjectPath} from '../../domain/project/project-path';
import {
    interruptedLabel,
    interruptionFromTail,
    parseLiveSessions,
    rekeyLiveSession,
    restoreOrder,
    withLiveSession,
    withoutLiveSessions,
} from '../../domain/session/restore';
import {COLOUR_WARN, statusBanner} from '../../domain/terminal/ansi';
import type {LiveSessionEntry} from '../../domain/session/restore';
import type {SessionOptions} from '../../domain/launch/session-options';
import type {ActiveSession} from '../model/active-session';
import type {SessionRegistry} from '../model/session-registry';
import type {Clock} from '../ports/clock';
import type {Logger} from '../ports/logger';
import type {RendererGateway} from '../ports/renderer-gateway';
import type {SessionRepository} from '../ports/session-repository';
import type {SettingsStore} from '../ports/settings-store';
import type {TranscriptStore} from '../ports/transcript-store';
import type {OpenSessionRequest, OpenSessionResult} from './session-launcher';

/** The settings-store key the record lives under. Machine state, not a preference. */
export const LIVE_SESSIONS_KEY = 'live-sessions';

/** How much of a transcript's end is read to see where its turn stood. */
const TAIL_BYTES = 65536;

export interface SessionRestoreDeps {
    store: Pick<SettingsStore, 'get' | 'set'>;
    /** The setting; off, nothing is restored and the record is cleared at start. */
    enabled(): boolean;
    /** The launch options a session in this folder is resumed with, as Resume uses. */
    optionsFor(projectPath: string): SessionOptions;
    launcher: {open(request: OpenSessionRequest): Promise<OpenSessionResult>};
    registry: Pick<SessionRegistry, 'get' | 'has'>;
    transcripts: Pick<TranscriptStore, 'readTail' | 'sessionMtimeMs'>;
    repository?: Pick<SessionRepository, 'getCachedFolder'>;
    renderer: Pick<RendererGateway, 'sessionNeedsAttention' | 'terminalNotification' | 'statusUpdate'>;
    fileExists(path: string): boolean;
    clock: Clock;
    log: Logger;
}

/** A restored session that was cut off, to mark once the window can hear it. */
interface InterruptedMark {
    sessionId: string;
    label: string;
}

export class SessionRestoreService {
    private frozen = false;
    private rendererIsReady = false;
    private marks: InterruptedMark[] = [];
    private notice: string | null = null;

    constructor(private readonly deps: SessionRestoreDeps) {}

    // ── Keeping the record ──

    /** A local Claude session started (or was resumed). */
    public started(sessionId: string, projectPath: string): void {
        const startedAt = new Date(this.deps.clock.now()).toISOString();
        this.write(withLiveSession(this.read(), {sessionId, projectPath, startedAt}));
    }

    /** A running session took a new id (a fork, an accepted plan). */
    public rekeyed(oldId: string, newId: string): void {
        const entries = this.read();
        if (!entries.some((e) => e.sessionId === oldId)) return;
        this.write(rekeyLiveSession(entries, oldId, newId));
    }

    /**
     * A session's process ended for good. Left in the record when the app
     * ended it on the way out, or once the app is quitting or the Mac shutting
     * down; taken out otherwise.
     */
    public ended(sessionId: string, session: Pick<ActiveSession, 'endedByApp' | 'priorIds'>): void {
        if (this.frozen || session.endedByApp) return;
        const ids = [sessionId, ...(session.priorIds ?? [])];
        const entries = this.read();
        if (!entries.some((e) => ids.includes(e.sessionId))) return;
        this.write(withoutLiveSessions(entries, ids));
    }

    /** The app is quitting or the Mac shutting down: whatever ends from now on comes back. */
    public freeze(): void {
        this.frozen = true;
    }

    // ── Restoring ──

    /**
     * Resume every session in the record that is not running, oldest first.
     * Called before a window opens; what the window should hear is held until
     * its renderer says it is ready.
     */
    public async restore(): Promise<void> {
        const {enabled, log} = this.deps;
        this.rendererIsReady = false;
        const entries = this.read();
        if (entries.length === 0) return;
        if (!enabled()) {
            log.info(`[restore] off; forgetting ${entries.length} session(s)`);
            this.write([]);
            return;
        }

        const missing: string[] = [];
        for (const entry of restoreOrder(entries)) {
            const outcome = await this.restoreOne(entry);
            if (outcome === 'folder-gone') missing.push(entry.projectPath);
        }

        if (missing.length > 0) {
            this.notice =
                missing.length === 1
                    ? `Couldn’t bring a session back: its folder is gone (${missing[0]})`
                    : `Couldn’t bring ${missing.length} sessions back: their folders are gone`;
        }
        if (this.rendererIsReady) this.flush();
    }

    /** The window's renderer is ready: mark the interrupted sessions, say what could not come back. */
    public rendererReady(): void {
        this.rendererIsReady = true;
        this.flush();
    }

    private async restoreOne(entry: LiveSessionEntry): Promise<'restored' | 'running' | 'folder-gone' | 'dropped'> {
        const {registry, fileExists, launcher, optionsFor, log} = this.deps;
        const {sessionId, projectPath} = entry;

        if (registry.has(sessionId)) return 'running';
        if (!fileExists(projectPath)) {
            log.warn(`[restore] ${sessionId}: ${projectPath} is gone; not restored`);
            this.drop(sessionId);
            return 'folder-gone';
        }

        // No transcript is a session that never got a prompt: there is no
        // conversation to resume, and `claude --resume` would only fail.
        const folder = this.transcriptFolder(sessionId, projectPath);
        if (!folder) {
            log.info(`[restore] ${sessionId}: no transcript; dropped`);
            this.drop(sessionId);
            return 'dropped';
        }

        // Read before the resume, which appends to the transcript.
        const interruption = interruptionFromTail(this.deps.transcripts.readTail(folder, sessionId, TAIL_BYTES));

        let opened: OpenSessionResult;
        try {
            opened = await launcher.open({sessionId, projectPath, isNew: false, options: optionsFor(projectPath)});
        } catch (err) {
            opened = {ok: false, error: (err as Error).message};
        }
        if (!opened.ok) {
            log.warn(`[restore] ${sessionId}: could not resume: ${opened.error}`);
            this.drop(sessionId);
            return 'dropped';
        }

        log.info(`[restore] ${sessionId} resumed in ${projectPath}${interruption ? ' (interrupted)' : ''}`);
        if (interruption) {
            const label = interruptedLabel(interruption);
            // In the scrollback too, so it is there when the session is opened.
            registry.get(sessionId)?.output.append(statusBanner(label, COLOUR_WARN));
            this.marks.push({sessionId, label});
        }
        return 'restored';
    }

    /** The transcript folder that holds the session, or null when it has no transcript. */
    private transcriptFolder(sessionId: string, projectPath: string): string | null {
        const {repository, transcripts} = this.deps;
        const candidates = [repository?.getCachedFolder(sessionId), encodeProjectPath(projectPath)];
        for (const folder of candidates) {
            if (folder && transcripts.sessionMtimeMs(folder, sessionId) !== null) return folder;
        }
        return null;
    }

    private flush(): void {
        const {renderer, registry} = this.deps;
        const marks = this.marks;
        this.marks = [];
        for (const {sessionId, label} of marks) {
            if (!registry.has(sessionId)) continue;
            renderer.sessionNeedsAttention(sessionId);
            renderer.terminalNotification(sessionId, label);
        }
        if (this.notice) {
            renderer.statusUpdate(this.notice, 'done');
            this.notice = null;
        }
    }

    private drop(sessionId: string): void {
        this.write(withoutLiveSessions(this.read(), [sessionId]));
    }

    private read(): LiveSessionEntry[] {
        return parseLiveSessions(this.deps.store.get(LIVE_SESSIONS_KEY));
    }

    private write(entries: LiveSessionEntry[]): void {
        this.deps.store.set(LIVE_SESSIONS_KEY, entries);
    }
}
